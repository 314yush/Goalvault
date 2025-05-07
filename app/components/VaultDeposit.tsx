"use client";

import React, { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { erc20Abi } from '../abis/erc20Abi';
import { morphoVaultAbi } from '../abis/morphoVaultAbi';
import { parseUnits, type Address } from 'viem';

const VAULT_ADDRESS = '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A' as Address; // Your specified vault address
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address; // USDC on Base
const USDC_DECIMALS = 6; // Standard for USDC

export default function VaultDeposit() {
  const [amount, setAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  
  // State for transaction hashes
  const [approvalTxHash, setApprovalTxHash] = useState<Address | undefined>(undefined);
  const [depositTxHash, setDepositTxHash] = useState<Address | undefined>(undefined);

  const { address: userAddress, isConnected } = useAccount();
  const { writeContractAsync, isPending: isWritePending, reset: resetWriteContract } = useWriteContract();

  // Hook for approval transaction
  const { 
    isLoading: isApproving, 
    isSuccess: isApprovalConfirmed, 
    error: approvalError 
  } = useWaitForTransactionReceipt({
    hash: approvalTxHash,
    confirmations: 1,
  });

  // Hook for deposit transaction
  const { 
    isLoading: isDepositing, 
    isSuccess: isDepositConfirmed, 
    error: depositError 
  } = useWaitForTransactionReceipt({
    hash: depositTxHash,
    confirmations: 1,
  });

  const handleInitiateDeposit = async () => {
    if (!isConnected || !userAddress) {
      setError("Please connect your wallet.");
      return;
    }
    if (!amount || parseFloat(amount) <= 0) {
      setError("Please enter a valid amount.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccessMessage(null);
    setApprovalTxHash(undefined);
    setDepositTxHash(undefined);
    resetWriteContract(); // Reset any previous write contract errors/state

    try {
      const amountInSmallestUnit = parseUnits(amount, USDC_DECIMALS);
      setSuccessMessage("Requesting approval to spend USDC...");
      const newApprovalTxHash = await writeContractAsync({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [VAULT_ADDRESS, amountInSmallestUnit],
      });
      setApprovalTxHash(newApprovalTxHash);
      setSuccessMessage(`Approval transaction sent: ${newApprovalTxHash}. Waiting for confirmation...`);
    } catch (err: any) {
      console.error("Approval failed to send:", err);
      setError(err.message || "Failed to send approval transaction.");
      setIsLoading(false);
    }
  };

  // Effect to trigger deposit after approval is confirmed
  useEffect(() => {
    async function executeDeposit() {
      if (isApprovalConfirmed && approvalTxHash && userAddress && !depositTxHash && !isDepositing) {
        setIsLoading(true); // Keep loading true for deposit step
        setError(null);
        setSuccessMessage("Approval confirmed. Sending deposit transaction...");
        resetWriteContract();
        try {
          const amountInSmallestUnit = parseUnits(amount, USDC_DECIMALS);
          const newDepositTxHash = await writeContractAsync({
            address: VAULT_ADDRESS,
            abi: morphoVaultAbi,
            functionName: 'deposit',
            args: [amountInSmallestUnit, userAddress],
          });
          setDepositTxHash(newDepositTxHash);
          setSuccessMessage(`Deposit transaction sent: ${newDepositTxHash}. Waiting for confirmation...`);
        } catch (err: any) {
          console.error("Deposit failed to send:", err);
          setError(err.message || "Failed to send deposit transaction.");
          setIsLoading(false); // Stop loading on deposit send error
        }
      }
    }
    executeDeposit();
  }, [isApprovalConfirmed, approvalTxHash, userAddress, amount, depositTxHash, isDepositing, writeContractAsync, resetWriteContract]);

  // Effect to handle final outcomes (approval error, deposit confirmation/error)
  useEffect(() => {
    if (approvalError && approvalTxHash) {
      setError(`Approval failed: ${approvalError.message || 'Unknown approval error'}`);
      setSuccessMessage(null);
      setIsLoading(false);
      setApprovalTxHash(undefined);
    }
    if (isDepositConfirmed && depositTxHash) {
      setSuccessMessage(`Transaction ${depositTxHash} successful! Your deposit is confirmed.`);
      setAmount(''); // Reset amount on final success
      setIsLoading(false);
      setApprovalTxHash(undefined); // Reset for next operation
      setDepositTxHash(undefined);
    }
    if (depositError && depositTxHash) {
      setError(`Deposit failed: ${depositError.message || 'Unknown deposit error'}`);
      setSuccessMessage(null);
      setIsLoading(false);
      setApprovalTxHash(undefined);
      setDepositTxHash(undefined);
    }
  }, [approvalError, isDepositConfirmed, depositError, approvalTxHash, depositTxHash]);

  // Consolidate loading state
  useEffect(() => {
    if (isWritePending || isApproving || isDepositing) {
      setIsLoading(true);
    } else {
      setIsLoading(false);
    }
  }, [isWritePending, isApproving, isDepositing]);

  if (!isConnected) {
    return <p>Please connect your wallet to deposit.</p>;
  }

  return (
    <div style={{ border: '1px solid #ccc', padding: '20px', borderRadius: '8px', maxWidth: '400px', margin: '20px auto' }}>
      <h3>Deposit USDC to Vault</h3>
      <p>Vault: {VAULT_ADDRESS}</p>
      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="depositAmount" style={{ display: 'block', marginBottom: '5px' }}>Amount (USDC):</label>
        <input
          id="depositAmount"
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          disabled={isLoading}
          style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ddd' }}
        />
      </div>
      <button
        onClick={handleInitiateDeposit}
        disabled={isLoading}
        style={{
          backgroundColor: isLoading ? '#aaa' : '#007bff',
          color: 'white',
          padding: '10px 15px',
          border: 'none',
          borderRadius: '4px',
          cursor: isLoading ? 'not-allowed' : 'pointer',
          width: '100%',
        }}
      >
        {isLoading ? (successMessage || 'Processing...') : 'Approve & Deposit'}
      </button>
      {error && <p style={{ color: 'red', marginTop: '10px' }}>Error: {error}</p>}
      {successMessage && <p style={{ color: (isApproving || isDepositing) ? 'blue' : 'green', marginTop: '10px' }}>{successMessage}</p>}
    </div>
  );
} 