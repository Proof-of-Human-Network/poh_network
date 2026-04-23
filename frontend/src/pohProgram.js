import { AnchorProvider, Program, BN } from '@coral-xyz/anchor'
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token'
import IDL from './poh_staking_idl.json'

export const PROGRAM_ID = new PublicKey('BN3bdfPeLTokUVACy9wShMVSCcaF1BqHx5Mg71Ere6CN')

// ── PDAs ──────────────────────────────────────────────────────────────────────
export const STATE_PDA    = PublicKey.findProgramAddressSync([Buffer.from('state')],      PROGRAM_ID)[0]
export const VAULT_PDA    = PublicKey.findProgramAddressSync([Buffer.from('vault')],      PROGRAM_ID)[0]
export const DFEE_PDA     = PublicKey.findProgramAddressSync([Buffer.from('dfee')],       PROGRAM_ID)[0]
export const SFEE_PDA     = PublicKey.findProgramAddressSync([Buffer.from('sfee')],       PROGRAM_ID)[0]

export function stakeRecordPDA(userPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('record'), userPubkey.toBytes()],
    PROGRAM_ID
  )[0]
}

export function methodRecordPDA(index) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(index))
  return PublicKey.findProgramAddressSync([Buffer.from('method'), buf], PROGRAM_ID)[0]
}

export function voteRecordPDA(methodIndex, voterPubkey) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(methodIndex))
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vote'), buf, voterPubkey.toBytes()],
    PROGRAM_ID
  )[0]
}

// ── Provider factory ──────────────────────────────────────────────────────────
function makeProvider(walletProvider, walletAddress, rpcUrl) {
  const conn = new Connection(rpcUrl, 'confirmed')
  const wallet = {
    publicKey: new PublicKey(walletAddress),
    signTransaction: tx => walletProvider.signTransaction(tx),
    signAllTransactions: txs => walletProvider.signAllTransactions(txs),
  }
  return new AnchorProvider(conn, wallet, { commitment: 'confirmed' })
}

function makeProgram(provider) {
  return new Program(IDL, provider)
}

// ── POH token balance ─────────────────────────────────────────────────────────
export async function getPohBalance(walletAddress, pohMint, rpcUrl) {
  try {
    const conn = new Connection(rpcUrl, 'confirmed')
    const mint = new PublicKey(pohMint)
    const user = new PublicKey(walletAddress)
    const ata  = await getAssociatedTokenAddress(mint, user)
    const info = await conn.getTokenAccountBalance(ata)
    return parseFloat(info.value.uiAmount || 0)
  } catch {
    return 0
  }
}

// ── Stake record (pending rewards) ───────────────────────────────────────────
export async function getStakeInfo(walletAddress, rpcUrl) {
  try {
    const conn = new Connection(rpcUrl, 'confirmed')
    const user = new PublicKey(walletAddress)
    const recordPDA = stakeRecordPDA(user)
    const raw = await conn.getAccountInfo(recordPDA)
    if (!raw) return { staked: 0, pendingRewards: 0 }

    // Decode manually: discriminator(8) + owner(32) + staked(8) + reward_debt(8) + pending_rewards(8) + staked_at(8)
    const data = raw.data
    const staked        = Number(data.readBigUInt64LE(8 + 32))
    const pendingRewards = Number(data.readBigUInt64LE(8 + 32 + 8 + 8))
    return { staked: staked / 1e6, pendingRewards: pendingRewards / 1e6 }
  } catch {
    return { staked: 0, pendingRewards: 0 }
  }
}

// ── Global state ──────────────────────────────────────────────────────────────
export async function getGlobalState(rpcUrl) {
  try {
    const conn = new Connection(rpcUrl, 'confirmed')
    const raw = await conn.getAccountInfo(STATE_PDA)
    if (!raw) return null
    // discriminator(8) + authority(32) + poh_mint(32) + stake_vault(32) + deployer_vault(32) + staker_fee_vault(32)
    // + bumps(3) + total_staked(8) + reward_per_token(16) + deployer_accumulated(8) + total_methods(8)
    const data = raw.data
    const totalMethods = Number(data.readBigUInt64LE(8 + 32*5 + 3 + 8 + 16 + 8))
    const totalStaked  = Number(data.readBigUInt64LE(8 + 32*5 + 3)) / 1e6
    return { totalMethods, totalStaked }
  } catch {
    return null
  }
}

// ── Ensure user ATA exists ────────────────────────────────────────────────────
async function ensureAta(conn, mint, owner, payer, walletProvider) {
  const ata = await getAssociatedTokenAddress(mint, owner)
  const info = await conn.getAccountInfo(ata)
  if (!info) {
    const { Transaction } = await import('@solana/web3.js')
    const tx = new (await import('@solana/web3.js')).Transaction().add(
      createAssociatedTokenAccountInstruction(payer, ata, owner, mint)
    )
    const { blockhash } = await conn.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = payer
    const signed = await walletProvider.signTransaction(tx)
    await conn.sendRawTransaction(signed.serialize())
  }
  return ata
}

// ── stake ─────────────────────────────────────────────────────────────────────
export async function stakeTokens(walletProvider, walletAddress, pohMint, rpcUrl, amountPoh) {
  const provider = makeProvider(walletProvider, walletAddress, rpcUrl)
  const program  = makeProgram(provider)
  const conn     = provider.connection
  const user     = new PublicKey(walletAddress)
  const mint     = new PublicKey(pohMint)
  const userAta  = await getAssociatedTokenAddress(mint, user)
  const rawAmount = new BN(Math.floor(amountPoh * 1e6))

  const txHash = await program.methods
    .stake(rawAmount)
    .accounts({
      state:       STATE_PDA,
      stakeVault:  VAULT_PDA,
      stakeRecord: stakeRecordPDA(user),
      userAta,
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc()
  return txHash
}

// ── unstake ───────────────────────────────────────────────────────────────────
export async function unstakeTokens(walletProvider, walletAddress, pohMint, rpcUrl, amountPoh) {
  const provider = makeProvider(walletProvider, walletAddress, rpcUrl)
  const program  = makeProgram(provider)
  const user     = new PublicKey(walletAddress)
  const mint     = new PublicKey(pohMint)
  const userAta  = await getAssociatedTokenAddress(mint, user)
  const rawAmount = new BN(Math.floor(amountPoh * 1e6))

  const txHash = await program.methods
    .unstake(rawAmount)
    .accounts({
      state:       STATE_PDA,
      stakeVault:  VAULT_PDA,
      stakeRecord: stakeRecordPDA(user),
      userAta,
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc()
  return txHash
}

// ── register method ───────────────────────────────────────────────────────────
export async function registerMethod(walletProvider, walletAddress, pohMint, rpcUrl, methodId, totalMethods) {
  const provider = makeProvider(walletProvider, walletAddress, rpcUrl)
  const program  = makeProgram(provider)
  const user     = new PublicKey(walletAddress)
  const mint     = new PublicKey(pohMint)
  const userAta  = await getAssociatedTokenAddress(mint, user)

  const txHash = await program.methods
    .registerMethod(methodId)
    .accounts({
      state:        STATE_PDA,
      methodRecord: methodRecordPDA(totalMethods),
      deployerVault: DFEE_PDA,
      stakerFeeVault: SFEE_PDA,
      userAta,
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc()
  return txHash
}

// ── cast vote ─────────────────────────────────────────────────────────────────
export async function castVote(walletProvider, walletAddress, rpcUrl, methodIndex, vote) {
  const provider = makeProvider(walletProvider, walletAddress, rpcUrl)
  const program  = makeProgram(provider)
  const voter    = new PublicKey(walletAddress)

  const txHash = await program.methods
    .castVote(new BN(methodIndex), vote)
    .accounts({
      state:        STATE_PDA,
      methodRecord: methodRecordPDA(methodIndex),
      stakeRecord:  stakeRecordPDA(voter),
      voteRecord:   voteRecordPDA(methodIndex, voter),
      voter,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc()
  return txHash
}

// ── claim staker rewards ──────────────────────────────────────────────────────
export async function claimStakerRewards(walletProvider, walletAddress, pohMint, rpcUrl) {
  const provider = makeProvider(walletProvider, walletAddress, rpcUrl)
  const program  = makeProgram(provider)
  const user     = new PublicKey(walletAddress)
  const mint     = new PublicKey(pohMint)
  const userAta  = await getAssociatedTokenAddress(mint, user)

  const txHash = await program.methods
    .claimStakerRewards()
    .accounts({
      state:          STATE_PDA,
      stakerFeeVault: SFEE_PDA,
      stakeRecord:    stakeRecordPDA(user),
      userAta,
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc()
  return txHash
}
