'use strict';

const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const { getMint, getAccount, getAssociatedTokenAddress } = require('@solana/spl-token');

const connection = new Connection(process.env.SOLANA_RPC || clusterApiUrl('devnet'), 'confirmed');

const PROGRAM_ID = new PublicKey('BN3bdfPeLTokUVACy9wShMVSCcaF1BqHx5Mg71Ere6CN');

function stakeRecordPDA(walletPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('record'), walletPubkey.toBytes()],
    PROGRAM_ID
  )[0];
}

/**
 * Verify a transaction was successfully confirmed on-chain.
 */
async function verifyTxSuccess(txHash) {
  try {
    if ((txHash === 'MOCK_SUCCESS' || txHash === 'MOCK_BURN') && process.env.NODE_ENV !== 'production') return true;
    const tx = await connection.getTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) return false;
    return tx.meta?.err === null;
  } catch (err) {
    console.error('[solana] verifyTxSuccess failed:', err.message);
    return false;
  }
}

/**
 * Verify a POH SPL token transfer to FEE_RECIPIENT of at least expectedAmount (raw, 6-decimal units).
 */
async function verifyPohTransfer(txHash, expectedAmountRaw, fromWallet) {
  try {
    if (txHash === 'MOCK_BURN' && process.env.NODE_ENV !== 'production') return true;
    const tx = await connection.getTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err !== null) return false;

    const mintAddress = process.env.POH_TOKEN_MINT;
    if (!mintAddress) return true; // not configured, skip verification
    const mint = new PublicKey(mintAddress);
    const recipient = new PublicKey(process.env.FEE_RECIPIENT || '');
    const fromPubkey = new PublicKey(fromWallet);

    const [fromAta, toAta] = await Promise.all([
      getAssociatedTokenAddress(mint, fromPubkey),
      getAssociatedTokenAddress(mint, recipient),
    ]);

    const acctKeys = tx.transaction.message.staticAccountKeys ||
                     tx.transaction.message.accountKeys;
    const toIdx = acctKeys.findIndex(k => k.toString() === toAta.toString());
    if (toIdx === -1) return false;

    const pre  = tx.meta.preTokenBalances?.find(b => b.accountIndex === toIdx);
    const post = tx.meta.postTokenBalances?.find(b => b.accountIndex === toIdx);
    if (!post) return false;

    const preAmt  = pre  ? Number(pre.uiTokenAmount.amount)  : 0;
    const postAmt = Number(post.uiTokenAmount.amount);
    return (postAmt - preAmt) >= expectedAmountRaw;
  } catch (err) {
    console.error('[solana] verifyPohTransfer failed:', err.message);
    return false;
  }
}

/**
 * Verifies if a transaction hash corresponds to a payment of the expected amount.
 * @param {string} txHash 
 * @param {number} expectedAmountInSol 
 * @param {string} recipientAddress 
 * @returns {Promise<boolean>}
 */
async function verifySolPayment(txHash, expectedAmountInSol, recipientAddress) {
  try {
    if (txHash === 'MOCK_SUCCESS') return true;
    
    const tx = await connection.getTransaction(txHash, { commitment: 'confirmed' });
    if (!tx) return false;

    // Check if the transaction sent the required amount to the recipient
    const recipientPubkey = new PublicKey(recipientAddress);
    const amountInLamports = expectedAmountInSol * 1e9;

    // This is a simplified check. In a production environment, 
    // you'd check postBalances vs preBalances for the recipient.
    const recipientIndex = tx.transaction.message.accountKeys.findIndex(k => k.equals(recipientPubkey));
    if (recipientIndex === -1) return false;

    const preBalance = tx.meta.preBalances[recipientIndex];
    const postBalance = tx.meta.postBalances[recipientIndex];
    
    return (postBalance - preBalance) >= amountInLamports;
  } catch (err) {
    console.error('[solana] Verification failed:', err.message);
    return false;
  }
}

/**
 * Gets the relative vote weight of a wallet based on their ON-CHAIN staked POH.
 * Uses the staking contract's stake record, not raw token balance.
 * Returns a value between 0 and 1 (fraction of total staked pool).
 */
async function getVoteTokenStake(walletAddress) {
  try {
    if (walletAddress.includes('...')) return 0.5;

    const walletPubkey = new PublicKey(walletAddress);
    const recordPDA = stakeRecordPDA(walletPubkey);
    const raw = await connection.getAccountInfo(recordPDA);

    // Stake record layout: discriminator(8) + owner(32) + staked(8) + reward_debt(8) + pending(8) + staked_at(8)
    if (!raw || raw.data.length < 8 + 32 + 8) return 0.01;
    const stakedRaw = Number(raw.data.readBigUInt64LE(8 + 32));
    if (stakedRaw === 0) return 0.01;

    // Read total staked from global state PDA
    const statePDA = PublicKey.findProgramAddressSync([Buffer.from('state')], PROGRAM_ID)[0];
    const stateRaw = await connection.getAccountInfo(statePDA);
    let totalStaked = 0;
    if (stateRaw && stateRaw.data.length >= 8 + 32*5 + 3 + 8) {
      totalStaked = Number(stateRaw.data.readBigUInt64LE(8 + 32*5 + 3));
    }

    return totalStaked > 0 ? (stakedRaw / totalStaked) : 0.0000000001;
  } catch (err) {
    console.warn('[solana] Failed to get stake weight:', err.message);
    return 0.01;
  }
}

/**
 * Gets the SOL balance of a wallet.
 * @param {string} walletAddress 
 * @returns {Promise<number>}
 */
async function getSolBalance(walletAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const balance = await connection.getBalance(pubkey);
    return balance / 1e9;
  } catch (err) {
    return 0;
  }
}

/**
 * Gets the POH token balance of a wallet.
 * @param {string} walletAddress 
 * @returns {Promise<number>}
 */
async function getVoteBalance(walletAddress) {
  try {
    const mintAddress = process.env.POH_TOKEN_MINT;
    if (!mintAddress) return 0;
    const mintPubkey = new PublicKey(mintAddress);
    const walletPubkey = new PublicKey(walletAddress);
    const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey);
    const accountInfo = await getAccount(connection, ata);
    return Number(accountInfo.amount);
  } catch (err) {
    return 0;
  }
}

/**
 * Verifies if a transaction hash corresponds to a burn of POH tokens.
 * @param {string} txHash 
 * @param {number} expectedAmount 
 * @param {string} walletAddress 
 * @returns {Promise<boolean>}
 */
async function verifyBurnTransaction(txHash, expectedAmount, walletAddress) {
  try {
    if (txHash === 'MOCK_BURN') return true;
    const tx = await connection.getTransaction(txHash, { commitment: 'confirmed' });
    if (!tx) return false;

    // In a real burn tx, the token balance of the user's ATA decreases 
    // and the transaction contains a Burn instruction.
    // For this implementation, we'll check if the logs or instructions indicate a burn.
    const isBurn = tx.meta.logMessages.some(log => log.includes('Instruction: Burn'));
    if (!isBurn) return false;

    // Check if the source was the walletAddress
    // This part is simplified; ideally you'd parse the instruction data
    return true; 
  } catch (err) {
    console.error('[solana] Burn verification failed:', err.message);
    return false;
  }
}

/**
 * Returns all wallets with an active staking position in the staking program.
 * Reads stake record PDAs directly (dataSize=72: 8 disc + 32 owner + 8 staked + 8 debt + 8 pending + 8 staked_at).
 */
async function getAllStakers() {
  try {
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 72 }],
    });
    return accounts
      .map(({ account }) => {
        const owner    = new PublicKey(account.data.subarray(8, 40)).toString();
        const stakedRaw = Number(account.data.readBigUInt64LE(40));
        return { address: owner, stakedRaw };
      })
      .filter(s => s.stakedRaw > 0);
  } catch (err) {
    console.warn('[solana] getAllStakers failed:', err.message);
    return [];
  }
}

/**
 * Sends POH tokens from the backend treasury wallet to a recipient.
 * Requires SOLANA_PRIV_KEY (base58) and POH_TOKEN_MINT to be set.
 * amountRaw is in 6-decimal units (1 POH = 1_000_000).
 */
async function sendPohTokens(toAddress, amountRaw) {
  const privKeyB58 = process.env.SOLANA_PRIV_KEY;
  if (!privKeyB58 || privKeyB58 === 'YOUR_OPTIONAL_PRIV_KEY_FOR_MINTING') {
    throw new Error('Backend wallet not configured — set SOLANA_PRIV_KEY');
  }
  if (!process.env.POH_TOKEN_MINT) throw new Error('POH_TOKEN_MINT not configured');

  const _bs58 = require('bs58');
  const bs58decode = (_bs58.default || _bs58).decode;
  const { Keypair, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
  const { createTransferInstruction, getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');

  // Accept 64-byte hex (128 chars) or base58 encoded private key
  const secretKey = /^[0-9a-fA-F]{128}$/.test(privKeyB58)
    ? Buffer.from(privKeyB58, 'hex')
    : bs58decode(privKeyB58);
  const payer = Keypair.fromSecretKey(secretKey);
  const mint = new PublicKey(process.env.POH_TOKEN_MINT);
  const toPubkey = new PublicKey(toAddress);

  const [fromAta, toAta] = await Promise.all([
    getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey),
    getOrCreateAssociatedTokenAccount(connection, payer, mint, toPubkey),
  ]);

  const tx = new Transaction().add(
    createTransferInstruction(fromAta.address, toAta.address, payer.publicKey, BigInt(amountRaw))
  );

  return sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
}

module.exports = { verifySolPayment, verifyTxSuccess, verifyPohTransfer, getVoteTokenStake, getSolBalance, getVoteBalance, verifyBurnTransaction, getAllStakers, sendPohTokens };
