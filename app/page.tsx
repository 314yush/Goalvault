"use client"; // For potential client-side interactions like Privy hooks

import React, { useState, useEffect, FormEvent } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { supabase, type Database } from '../lib/supabaseClient'; // Import Supabase client and Database type
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryResult
} from '@tanstack/react-query';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useEnsName, useSwitchChain } from 'wagmi'; // Removed useNetwork
import { base } from 'viem/chains'; // Import base chain definition
import { erc20Abi } from './abis/erc20Abi'; // Moved ABI import
import { morphoVaultAbi } from './abis/morphoVaultAbi'; // Moved ABI import
import { parseUnits, type Address } from 'viem'; // Moved viem import
import GoalCountdown from './components/GoalCountdown'; // Added import for GoalCountdown
import { gql, useQuery as useApolloQuery } from '@apollo/client'; // Import Apollo Client hooks

// Define the type for a single goal, aligning with your Database interface
type Goal = Database['public']['Tables']['goals']['Row'];
type GoalInsert = Omit<Database['public']['Tables']['goals']['Insert'], 'end_date'> & { end_date?: string | null };

// For MVP, using a fixed vault address. This should eventually be configurable or selected.
const DEFAULT_VAULT_ADDRESS = '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A' as Address;

// Constants for deposit moved here
const VAULT_ADDRESS = '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A' as Address;
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address; 
const USDC_DECIMALS = 6;

// GraphQL Query for Vault APR
const GET_VAULT_APR = gql`
  query GetVaultData($vaultAddress: String!, $chainId: Int!) {
    vaultByAddress(address: $vaultAddress, chainId: $chainId) {
      address #Confirming the address
      name
      state {
        apy # Native APY
        netApy # APY including rewards and fees - this is likely what we want
      }
      # Optional: to confirm curator if available via API
      # metadata {
      #   curators {
      #     name
      #   }
      # }
    }
  }
`;

export default function HomePage() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const queryClient = useQueryClient();
  const { address: userAddress, isConnected, chain: activeChain } = useAccount();
  const { chains, switchChainAsync, isPending: isSwitchingNetwork, error: switchChainError, status } = useSwitchChain();

  // Predefined goal titles
  const PREDEFINED_GOAL_TITLES = [
    "Save for an international trip",
    "Buy a new car",
    "Down payment for a house",
    "Create an emergency fund",
    // Add more predefined goals if needed
  ];
  const CUSTOM_GOAL_VALUE = "custom";

  // Fetch ENS name for the connected userAddress
  const { data: ensName, isLoading: isLoadingEnsName } = useEnsName({
    address: userAddress, // If userAddress is undefined, the query won't run or will return no data
    chainId: 1, // ENS is typically resolved on Ethereum mainnet
  });

  // Goal form state
  const [title, setTitle] = useState(PREDEFINED_GOAL_TITLES[0]); // Default to the first predefined title
  const [customGoalTitle, setCustomGoalTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetAmount, setTargetAmount] = useState(''); // This is the GOAL's target
  const [initialDepositAmount, setInitialDepositAmount] = useState(''); // New state for initial deposit
  const [goalEndDate, setGoalEndDate] = useState('');

  // Fetch Vault APR
  const { data: vaultData, loading: isLoadingVaultAPR, error: vaultAPRError } = useApolloQuery(GET_VAULT_APR, {
    variables: { vaultAddress: VAULT_ADDRESS, chainId: 8453 }, // chainId for Base is 8453
    skip: !VAULT_ADDRESS, // Skip if VAULT_ADDRESS is not set (though it's a constant here)
  });

  // Deposit transaction state (moved from VaultDeposit)
  const [isLoadingTx, setIsLoadingTx] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccessMessage, setTxSuccessMessage] = useState<string | null>(null);
  const [approvalTxHash, setApprovalTxHash] = useState<Address | undefined>(undefined);
  const [depositTxHash, setDepositTxHash] = useState<Address | undefined>(undefined);
  const [amountToDeposit, setAmountToDeposit] = useState<string>(''); // To store amount for deposit step
  const [createdGoalId, setCreatedGoalId] = useState<string | null>(null); // New state for created goal ID

  // Wagmi hooks for transactions (moved from VaultDeposit)
  const { writeContractAsync, isPending: isWritePending, reset: resetWriteContract } = useWriteContract();

  // State for managing individual goal deposits
  const [increaseDepositAmounts, setIncreaseDepositAmounts] = useState<{[goalId: string]: string}>({});
  const [currentDepositingGoalId, setCurrentDepositingGoalId] = useState<string | null>(null);

  const { 
    isLoading: isApproving, 
    isSuccess: isApprovalConfirmed, 
    error: approvalError 
  } = useWaitForTransactionReceipt({
    hash: approvalTxHash,
    confirmations: 1,
  });

  const { 
    isLoading: isDepositing, 
    isSuccess: isDepositConfirmed, 
    error: depositError 
  } = useWaitForTransactionReceipt({
    hash: depositTxHash,
    confirmations: 1,
  });

  // Effect to set Supabase auth token when Privy auth state changes
  useEffect(() => {
    const setAuthToken = async () => {
      if (authenticated) {
        try {
          console.log("HomePage: useEffect - Authenticated. Getting Privy token...");
          const token = await getAccessToken();
          if (token) {
            console.log("HomePage: useEffect - Privy token received. Setting Supabase session.");
            const { error: sessionError } = await supabase.auth.setSession({ access_token: token, refresh_token: '' });
            if (sessionError) console.error("HomePage: useEffect - Error setting Supabase session:", sessionError);
            else console.log("HomePage: useEffect - Supabase session potentially set.");
          } else {
            console.log("HomePage: useEffect - No access token from Privy.");
          }
        } catch (error) {
          console.error("HomePage: useEffect - Error handling Privy token:", error);
        }
      }
    };
    if (ready) {
      console.log("HomePage: useEffect - Privy is ready. Authenticated status:", authenticated);
      setAuthToken();
    }
  }, [authenticated, getAccessToken, ready]);

  // NEW fetchGoalsFn that calls the Edge Function
  const fetchGoalsFn = async (): Promise<Goal[]> => {
    console.log("fetchGoalsFn (Edge Function version) called. User ID:", user?.id, "Authenticated:", authenticated);
    if (!user?.id) { // Still good to have client-side check for enabling query
      console.log("fetchGoalsFn: No user ID, client-side block.");
      // This won't be thrown if query is disabled, but good practice
      throw new Error("User not authenticated or user ID missing for fetch."); 
    }

    const privyAccessToken = await getAccessToken();
    if (!privyAccessToken) {
      console.log("fetchGoalsFn: Missing Privy access token for Edge Function call.");
      throw new Error("Authentication token not available.");
    }

    const edgeFunctionUrl = process.env.NEXT_PUBLIC_GET_GOALS_FUNCTION_URL; // New Env Var
    if (!edgeFunctionUrl) {
      console.error("Get Goals Edge Function URL is not configured (NEXT_PUBLIC_GET_GOALS_FUNCTION_URL).");
      throw new Error("Server configuration error: Missing function URL for get-goals.");
    }

    console.log(`fetchGoalsFn: Calling Edge Function at ${edgeFunctionUrl}`);
    const response = await fetch(edgeFunctionUrl, {
      method: 'GET', // GET request
      headers: {
        'Authorization': `Bearer ${privyAccessToken}`,
        'Content-Type': 'application/json' // Good practice, though GET has no body
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      console.error("Error calling get-goals Edge Function:", errorData);
      throw new Error(errorData.details || errorData.error || `Failed to fetch goals: ${response.statusText}`);
    }

    const data = await response.json();
    console.log("fetchGoalsFn: Data received from Edge Function:", data);
    return data as Goal[]; // Assuming Edge function returns Goal[] or empty array
  };

  // The useQuery hook remains structurally the same, but will now use the new fetchGoalsFn
  // console.log("HomePage: Current user ID for useQuery setup:", user?.id); // Already there
  const { data: goals, isLoading: isLoadingGoals, error: goalsError, refetch: refetchGoals }: UseQueryResult<Goal[], Error> = useQuery({
    queryKey: ['goals', user?.id],
    queryFn: fetchGoalsFn, // This now calls the Edge Function
    enabled: !!authenticated && !!user?.id && !!getAccessToken, // Ensure getAccessToken is available too
  });

  // Update the createGoalFn to call the Edge Function
  const createGoalFn = async (newGoalData: Omit<GoalInsert, 'user_id' | 'id' | 'created_at' | 'updated_at' | 'current_funded_amount'> & { end_date?: string | null }): Promise<Goal | null> => {
    const privyAccessToken = await getAccessToken();
    if (!privyAccessToken) {
      throw new Error("User not authenticated: Missing Privy access token.");
    }
    const edgeFunctionUrl = process.env.NEXT_PUBLIC_CREATE_GOAL_FUNCTION_URL;
    if (!edgeFunctionUrl) {
      console.error("Create Goal Edge Function URL is not configured.");
      throw new Error("Server configuration error: Missing function URL.");
    }
    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${privyAccessToken}` },
      body: JSON.stringify(newGoalData),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      console.error("Error calling create-goal Edge Function:", errorData);
      throw new Error(errorData.details || errorData.error || `Failed to create goal: ${response.statusText}`);
    }
    return response.json();
  };

  // useMutation hook remains largely the same, but the input type for mutate might simplify
  // The `GoalInsert` type for the mutation variables might need adjustment if we're not passing user_id from client
  const createGoalMutation = useMutation<Goal | null, Error, Omit<GoalInsert, 'user_id' | 'id' | 'created_at' | 'updated_at' | 'current_funded_amount'> & { end_date?: string | null }>({
    mutationFn: async (newGoalData) => {
      // Call the existing createGoalFn (which calls the Edge function)
      const privyAccessToken = await getAccessToken();
      if (!privyAccessToken) throw new Error("User not authenticated: Missing Privy access token.");
      const edgeFunctionUrl = process.env.NEXT_PUBLIC_CREATE_GOAL_FUNCTION_URL;
      if (!edgeFunctionUrl) throw new Error("Server configuration error: Missing function URL for create-goal.");
      const response = await fetch(edgeFunctionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${privyAccessToken}` },
          body: JSON.stringify(newGoalData),
      });
      if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: response.statusText }));
          throw new Error(errorData.details || errorData.error || `Failed to create goal: ${response.statusText}`);
      }
      return response.json();
    },
    onSuccess: (createdGoal, variables) => {
      console.log('Goal created successfully in DB:', createdGoal);
      queryClient.invalidateQueries({ queryKey: ['goals', user?.id] });
      setTitle(PREDEFINED_GOAL_TITLES[0]); // Reset to default predefined title
      setCustomGoalTitle(''); // Reset custom title
      setDescription('');
      setTargetAmount(''); // Clear goal target amount form field
      setGoalEndDate('');
      // Use initialDepositAmount from state for the deposit flow
      const depositNowAmount = parseFloat(initialDepositAmount);

      if (createdGoal && createdGoal.id && depositNowAmount > 0) {
        setTxSuccessMessage("Goal saved! Proceeding to deposit...");
        setAmountToDeposit(initialDepositAmount); // amountToDeposit state now uses initialDepositAmount
        setCreatedGoalId(createdGoal.id); 
        initiateApproval(initialDepositAmount); 
      } else {
        // No initial deposit or zero amount, just clear the form and potentially show a success message for goal creation
        setTxSuccessMessage("Goal created successfully!");
        setInitialDepositAmount(''); // Clear initial deposit field too
      }
    },
    onError: (error: Error) => {
      console.error("Error creating goal:", error.message);
      alert(`Error creating goal: ${error.message}`);
      setIsLoadingTx(false);
    }
  });
  
  const initiateApproval = async (depositValue: string) => {
    console.log("initiateApproval called. Current activeChain:", activeChain);
    if (!isConnected || !userAddress) {
      setTxError("Please connect your wallet to deposit."); return;
    }

    if (!activeChain) {
      setTxError("Chain information not available. Please ensure your wallet is connected properly and refresh.");
      // Optionally, attempt to prompt for connection or network switch here if appropriate
      return;
    }

    if (parseFloat(depositValue) <= 0) { // Check depositValue before network switch for non-zero amounts
      setTxError("Invalid amount for deposit."); return;
    }

    // Network Check
    if (activeChain.id !== base.id) {
      setTxError(`Please switch to the ${base.name} network to continue.`);
      try {
        if (!switchChainAsync) {
            setTxError("Network switching feature is not available. Please switch manually in your wallet.");
            return;
        }
        setTxSuccessMessage(`Requesting network switch to ${base.name}...`);
        // isSwitchingNetwork will be true via useSwitchChain hook
        await switchChainAsync({ chainId: base.id });
        // After switch, wagmi updates context, useAccount provides new activeChain, component re-renders.
        // User will need to click again. Successful switch message can be shown based on new activeChain.
        // If switchChainAsync throws, it's caught below.
        // If user rejects, it might also throw or resolve without switching.
        // The UI should update based on the new activeChain.
        return; 
      } catch (err: any) {
        console.error("Failed to switch network:", err);
        setTxError(err.message || "Failed to switch network. Please do it manually in your wallet.");
        return;
      }
    }

    // Clear previous errors/success if network is correct now
    setTxError(null);
    // setTxSuccessMessage(null); // Keep existing success messages if they are part of an ongoing flow

    console.log(`Proceeding with approval on ${activeChain.name} (ID: ${activeChain.id})`);
    setIsLoadingTx(true);
    setTxSuccessMessage("Requesting approval to spend USDC...");
    setApprovalTxHash(undefined);
    setDepositTxHash(undefined);
    resetWriteContract();

    try {
      const amountInSmallestUnit = parseUnits(depositValue, USDC_DECIMALS);
      const newApprovalTxHash = await writeContractAsync({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [VAULT_ADDRESS, amountInSmallestUnit],
      });
      setApprovalTxHash(newApprovalTxHash);
      setTxSuccessMessage(`Approval transaction sent: ${newApprovalTxHash}. Waiting for confirmation...`);
    } catch (err: any) {
      console.error("Approval failed to send:", err);
      setTxError(err.message || "Failed to send approval transaction.");
      setIsLoadingTx(false);
    }
  };

  // Effect to trigger deposit after approval is confirmed
  useEffect(() => {
    async function executeDeposit() {
      if (isApprovalConfirmed && approvalTxHash && userAddress && amountToDeposit && !depositTxHash && !isDepositing) {
        setIsLoadingTx(true); 
        setTxError(null);
        setTxSuccessMessage("Approval confirmed. Sending deposit transaction...");
        resetWriteContract();
        try {
          const amountInSmallestUnit = parseUnits(amountToDeposit, USDC_DECIMALS);
          const newDepositTxHash = await writeContractAsync({
            address: VAULT_ADDRESS,
            abi: morphoVaultAbi,
            functionName: 'deposit',
            args: [amountInSmallestUnit, userAddress],
          });
          setDepositTxHash(newDepositTxHash);
          setTxSuccessMessage(`Deposit transaction sent: ${newDepositTxHash}. Waiting for confirmation...`);
        } catch (err: any) {
          console.error("Deposit failed to send:", err);
          setTxError(err.message || "Failed to send deposit transaction.");
          setIsLoadingTx(false);
        }
      }
    }
    executeDeposit();
  }, [isApprovalConfirmed, approvalTxHash, userAddress, amountToDeposit, depositTxHash, isDepositing, writeContractAsync, resetWriteContract]);

  // Effect to handle final transaction outcomes AND UPDATE GOAL FUNDING
  useEffect(() => {
    const handleDepositSuccess = async () => {
      if (isDepositConfirmed && depositTxHash && (createdGoalId || currentDepositingGoalId) && amountToDeposit) {
        setTxSuccessMessage(`Deposit successful! Updating goal funding...`);
        setIsLoadingTx(true); // Keep loading while updating DB

        const goalIdToUpdate = createdGoalId || currentDepositingGoalId;
        if (!goalIdToUpdate) {
          setTxError("Critical error: Goal ID missing for update.");
          setIsLoadingTx(false);
          return;
        }

        try {
          const privyAccessToken = await getAccessToken();
          if (!privyAccessToken) throw new Error("Authentication token not available for updating goal.");
          
          const updateFnUrl = process.env.NEXT_PUBLIC_UPDATE_GOAL_FUNDING_FUNCTION_URL;
          if (!updateFnUrl) throw new Error("Update Goal Funding Edge Function URL not configured.");

          const response = await fetch(updateFnUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${privyAccessToken}` },
            body: JSON.stringify({ goal_id: goalIdToUpdate, deposited_amount: parseFloat(amountToDeposit) }),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(errorData.details || errorData.error || 'Failed to update goal funding.');
          }
          
          setTxSuccessMessage(`Transaction ${depositTxHash} successful! Deposit confirmed & goal updated.`);
          queryClient.invalidateQueries({ queryKey: ['goals', user?.id] }); // Refetch goals to show updated progress
          setInitialDepositAmount(''); // Clear this new field as well
          setCreatedGoalId(null);
          setTargetAmount(''); // Also reset the form input for targetAmount
          setIncreaseDepositAmounts(prev => ({ ...prev, [goalIdToUpdate]: '' })); // Clear specific goal deposit input
          setCurrentDepositingGoalId(null); // Reset current depositing goal
        } catch (updateError: any) {
          console.error("Error updating goal funding:", updateError);
          setTxError(`Deposit confirmed, but failed to update goal funding: ${updateError.message}`);
          // Still, the deposit itself was successful, so we don't want to mislead the user too much.
          // Consider how to handle this partial success scenario in UI.
        } finally {
          setIsLoadingTx(false);
          setApprovalTxHash(undefined);
          setDepositTxHash(undefined);
          setAmountToDeposit('');
          setInitialDepositAmount(''); // Clear this new field as well
          setCreatedGoalId(null);
          setTargetAmount(''); // Also reset the form input for targetAmount
          setIncreaseDepositAmounts(prev => ({ ...prev, [goalIdToUpdate]: '' })); // Clear specific goal deposit input
          setCurrentDepositingGoalId(null); // Reset current depositing goal
        }
      }
    };

    if (isDepositConfirmed && depositTxHash) {
      handleDepositSuccess();
    } else if (approvalError && approvalTxHash) {
      setTxError(`Approval failed: ${approvalError.message || 'Unknown approval error'}`);
      setTxSuccessMessage(null);
      setIsLoadingTx(false);
      setApprovalTxHash(undefined);
      setInitialDepositAmount('');
      setCreatedGoalId(null); 
      if (currentDepositingGoalId) {
        setIncreaseDepositAmounts(prev => ({ ...prev, [currentDepositingGoalId]: '' }));
        setCurrentDepositingGoalId(null);
      }
    } else if (depositError && depositTxHash) {
      setTxError(`Deposit failed: ${depositError.message || 'Unknown deposit error'}`);
      setTxSuccessMessage(null);
      setIsLoadingTx(false);
      setApprovalTxHash(undefined); 
      setDepositTxHash(undefined); 
      setInitialDepositAmount('');
      setCreatedGoalId(null); 
      if (currentDepositingGoalId) {
        setIncreaseDepositAmounts(prev => ({ ...prev, [currentDepositingGoalId]: '' }));
        setCurrentDepositingGoalId(null);
      }
      setAmountToDeposit('');
    }
  }, [isDepositConfirmed, depositTxHash, approvalError, approvalTxHash, depositError, createdGoalId, currentDepositingGoalId, amountToDeposit, getAccessToken, queryClient, user?.id, initialDepositAmount]);

  // Consolidate overall loading state (goal creation + transaction)
  useEffect(() => {
    if (createGoalMutation.isPending || isWritePending || isApproving || isDepositing) {
      setIsLoadingTx(true);
    } else {
      setIsLoadingTx(false);
    }
  }, [createGoalMutation.isPending, isWritePending, isApproving, isDepositing]);

  const handleCreateGoalAndDeposit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user?.id) { 
      alert("Please log in to create a goal."); return;
    }
    // Network check for initial deposit flow
    if (!activeChain) {
      alert("Chain information not available. Please ensure your wallet is connected properly and refresh.");
      return;
    }
    if (activeChain.id !== base.id && parseFloat(initialDepositAmount) > 0) {
        setTxError(`Please switch to the ${base.name} network to make an initial deposit.`);
        if (switchChainAsync) {
            try {
                // setTxSuccessMessage(`Requesting network switch to ${base.name}...`); // Message handled by button text
                await switchChainAsync({ chainId: base.id });
                // User needs to re-click after switch
            } catch (err:any) {
                setTxError(err.message || "Failed to switch network. Please do it manually.");
            }
        } else {
            alert(`Please switch to the ${base.name} network in your wallet before creating a goal with a deposit.`);
        }
        return;
    }

    const finalTitle = title === CUSTOM_GOAL_VALUE ? customGoalTitle.trim() : title;

    // Updated validation for mandatory initial deposit and target > initial
    if (!finalTitle || !targetAmount || !goalEndDate || !initialDepositAmount) { 
      alert("Title, Goal Target Amount, End Date, and Initial Deposit Amount are required."); return;
    }
    if (title === CUSTOM_GOAL_VALUE && !customGoalTitle.trim()) {
      alert("Please enter your custom goal title."); return;
    }
    
    const initialDeposit = parseFloat(initialDepositAmount);
    if (isNaN(initialDeposit) || initialDeposit <= 0) { // Must be positive
        alert("Please enter a valid positive number for the initial deposit.");
        return;
    }

    const target = parseFloat(targetAmount);
    if (isNaN(target) || target <= 0) { // Also ensure target is positive
        alert("Please enter a valid positive number for the goal target amount.");
      return;
    }

    if (target <= initialDeposit) {
        alert("Goal Target Amount must be greater than the Initial Deposit Amount.");
      return;
    }

    setTxError(null);
    setTxSuccessMessage(null);
    setIsLoadingTx(true); 
    setTxSuccessMessage("Saving goal to database...");

    createGoalMutation.mutate({
      title: finalTitle, // Use the derived finalTitle
      description: description || undefined,
      target_amount: parseFloat(targetAmount), // This is the GOAL's target
      vault_address: DEFAULT_VAULT_ADDRESS,
      end_date: goalEndDate ? new Date(goalEndDate).toISOString() : null,
      // initial_deposit_amount is NOT part of the GoalInsert type for the DB
      // It's handled client-side to trigger the deposit flow
    });
  };

  const handleIncreaseDeposit = async (goalId: string, depositValue: string) => {
    if (!isConnected || !userAddress) {
      setTxError("Please connect your wallet to deposit."); return;
    }
    if (!activeChain) {
      alert("Chain information not available. Please ensure your wallet is connected properly and refresh.");
      return;
    }
    // Network Check (initiateApproval will also check, this is an early exit)
    if (activeChain.id !== base.id) {
      setTxError(`Please switch to the ${base.name} network to deposit.`);
      if (switchChainAsync) {
        try {
            // setTxSuccessMessage(`Requesting network switch to ${base.name}...`);
            await switchChainAsync({ chainId: base.id });
            // User needs to re-click
        } catch (err:any) {
            setTxError(err.message || "Failed to switch network. Please do it manually.");
        }
      } else {
        alert(`Please switch to the ${base.name} network in your wallet to deposit.`);
      }
      return;
    }

    const amount = parseFloat(depositValue);
    if (isNaN(amount) || amount <= 0) {
      setTxError("Please enter a valid positive amount to deposit."); return;
    }

    const goal = goals?.find(g => g.id === goalId);
    if (!goal) {
      setTxError("Goal not found. Cannot proceed with deposit."); return;
    }

    const remainingToFund = goal.target_amount - (goal.current_funded_amount || 0);
    if (amount > remainingToFund) {
      setTxError(`You can deposit a maximum of ${remainingToFund.toFixed(USDC_DECIMALS)} USDC for this goal.`);
      // Clear the input for this specific goal if over limit
      setIncreaseDepositAmounts(prev => ({ ...prev, [goalId]: remainingToFund > 0 ? remainingToFund.toFixed(USDC_DECIMALS) : '0' }));
      return;
    }

    setTxError(null);
    setTxSuccessMessage(null);
    setIsLoadingTx(true);
    setAmountToDeposit(depositValue); // Set the global amountToDeposit for the approval/deposit flow
    setCurrentDepositingGoalId(goalId); // Set the goal ID we are depositing to
    setCreatedGoalId(null); // Ensure this is null as we are not creating a new goal

    // Initiate approval for the specific amount
    initiateApproval(depositValue);
  };

  if (!ready) {
    return <p>Loading authentication state...</p>;
  }

  return (
    <main style={{ padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>GoalFunding App (Base)</h1>
        {authenticated ? (
          <button onClick={logout} className="button-danger">
            Log Out ({isLoadingEnsName ? '...' : ensName || (userAddress ? `${userAddress.substring(0, 6)}...${userAddress.substring(userAddress.length - 4)}` : 'User')})
          </button>
        ) : (
          <button onClick={login} className="button-primary">
            Log In with Privy
          </button>
        )}
      </header>

      {authenticated && user ? (
        <>
          <section style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #333', borderRadius: '8px' }}>
            <h2>Create New Goal & Deposit</h2>
            <form onSubmit={handleCreateGoalAndDeposit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label htmlFor="goalTitleSelect">Title:</label>
                <select 
                  id="goalTitleSelect"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  style={{ marginRight: title === CUSTOM_GOAL_VALUE ? '0.5rem' : '0', width: '100%', padding: '0.5rem', boxSizing: 'border-box'}} 
                >
                  {PREDEFINED_GOAL_TITLES.map(t => <option key={t} value={t}>{t}</option>)}
                  <option value={CUSTOM_GOAL_VALUE}>Custom Goal...</option>
                </select>
                {title === CUSTOM_GOAL_VALUE && (
                  <input
                    id="customGoalTitle"
                    type="text"
                    value={customGoalTitle}
                    onChange={(e) => setCustomGoalTitle(e.target.value)}
                    placeholder="Enter your custom goal title"
                    required
                    style={{ marginTop: '0.5rem', width: '100%', padding: '0.5rem', boxSizing: 'border-box' }} 
                  />
                )}
              </div>
              <div>
                <label htmlFor="description">Description (Optional):</label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box', minHeight: '80px' }} 
                />
              </div>
              <div>
                <label htmlFor="targetAmount">Goal Target Amount (USDC):</label>
                <input id="targetAmount" type="number" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} required step="0.01" style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label htmlFor="initialDepositAmount">Initial Deposit (USDC):</label>
                <input
                  id="initialDepositAmount"
                  type="number"
                  value={initialDepositAmount} 
                  onChange={(e) => setInitialDepositAmount(e.target.value)} 
                  placeholder="0.00" 
                  step="0.01"
                  required
                  style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }} 
                />
              </div>
              <div>
                <label htmlFor="goalEndDate">Goal End Date:</label>
                <input id="goalEndDate" type="date" value={goalEndDate} onChange={(e) => setGoalEndDate(e.target.value)} required style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }} />
              </div>

              {/* Vault Information Section */}
              <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed #eee', background: '#2a2a2a', padding: '1rem', borderRadius: '4px'}}>
                <h4>Vault Details:</h4>
                <p style={{fontSize: '0.9em', margin: '0.25rem 0'}}>
                  Address: <a href={"https://app.morpho.org/base/vault/0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A/spark-usdc-vault"} target="_blank" rel="noopener noreferrer" style={{color: '#75A9D9'}}>
                    {`${VAULT_ADDRESS.substring(0, 6)}...${VAULT_ADDRESS.substring(VAULT_ADDRESS.length - 4)}`}
                  </a>
                </p>
                <p style={{fontSize: '0.9em', margin: '0.25rem 0'}}>
                  Network: Base
                </p>
                <p style={{fontStyle: 'italic', fontSize: '0.9em', margin: '0.25rem 0'}}>
                  This vault is on Morpho, curated by Spark DAO.
                </p>
                {isLoadingVaultAPR && <p style={{fontSize: '0.9em', margin: '0.25rem 0'}}>Fetching APR...</p>}
                {vaultAPRError && <p style={{color: 'orange', fontSize: '0.9em', margin: '0.25rem 0'}}>Error fetching APR: {vaultAPRError.message}</p>}
                {vaultData && vaultData.vaultByAddress && (
                  <p style={{fontSize: '0.9em', margin: '0.25rem 0'}}>
                    <strong>Net APY: {(parseFloat(vaultData.vaultByAddress.state.netApy) * 100).toFixed(2)}%</strong> 
                    {/* Raw APY (native): {(parseFloat(vaultData.vaultByAddress.state.apy) * 100).toFixed(2)}% */}
                  </p>
                )}
                {/* {vaultData?.vaultByAddress?.metadata?.curators && vaultData.vaultByAddress.metadata.curators.length > 0 && (
                  <p style={{fontSize: '0.9em', margin: '0.25rem 0'}}>
                    Curator(s): {vaultData.vaultByAddress.metadata.curators.map(c => c.name).join(', ')}
                  </p>
                )} */}
              </div>

              <button 
                type="submit" 
                disabled={isLoadingTx || isLoadingVaultAPR || (isConnected && activeChain && activeChain.id !== base.id) || isSwitchingNetwork}
                className="button-primary" 
                style={{marginTop: '1rem'}}
              >
                {isConnected && activeChain && activeChain.id !== base.id 
                  ? `Switch to ${base.name}` 
                  : isSwitchingNetwork 
                    ? 'Switching Network...'
                    : isLoadingTx 
                      ? (txSuccessMessage || 'Processing...') 
                      : (isLoadingVaultAPR ? 'Loading Vault Info...' : 'Create Goal & Deposit')}
              </button>
              {/* Displaying transaction errors and successes */}
              {txError && <p style={{ color: 'red' }}>Error: {txError}</p>}
              {txSuccessMessage && !isLoadingTx && <p style={{ color: 'green' }}>{txSuccessMessage}</p>}
              {isLoadingTx && txSuccessMessage && <p style={{ color: 'blue' }}>Status: {txSuccessMessage}</p>} {/* Show ongoing status when loading */}
              {/* Goal creation specific errors (if mutation fails before tx) */}
              {createGoalMutation.isError && !txError && <p style={{color: 'red'}}>Goal Creation Error: {createGoalMutation.error?.message}</p>}
            </form>
          </section>

          <section>
            <h2>Your Goals</h2>
            {isLoadingGoals && <p>Loading your goals...</p>}
            {goalsError && <p style={{ color: 'red' }}>Error: {goalsError.message}</p>}
            {goals && goals.length === 0 && !isLoadingGoals && <p>No goals yet.</p>}
            {goals && goals.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {goals.map((goal: Goal) => {
                  const remainingToFund = goal.target_amount - (goal.current_funded_amount || 0);
                  const isFullyFunded = remainingToFund <= 0;
                  const currentIncreaseAmountString = increaseDepositAmounts[goal.id] || '';
                  const currentIncreaseAmount = parseFloat(currentIncreaseAmountString);
                  const isIncreaseAmountValid = !isNaN(currentIncreaseAmount) && currentIncreaseAmount > 0 && currentIncreaseAmount <= remainingToFund;

                  return (
                  <li key={goal.id} style={{ marginBottom: '1rem', padding: '1rem', border: '1px solid #333', borderRadius: '8px' }}>
                    <h3>{goal.title}</h3>
                    {goal.description && <p>{goal.description}</p>}
                    <p>
                      Progress: {goal.current_funded_amount} / {goal.target_amount} USDC
                    </p>
                    <p><small>Vault: {goal.vault_address ? `${goal.vault_address.substring(0, 6)}...${goal.vault_address.substring(goal.vault_address.length - 4)}` : 'N/A'}</small></p>
                    <p><small>Created: {new Date(goal.created_at).toLocaleString()}</small></p>
                    {/* Removed GoalCountdown component due to 'end_date' property not existing on the 'Goal' type */}
                    
                    {/* Increase Deposit Section */}
                    <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px dashed #ccc', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <label htmlFor={`increase-deposit-${goal.id}`} style={{ marginRight: '0.5rem' }}>Increase Deposit (USDC):</label>
                      <input 
                        type="number"
                        id={`increase-deposit-${goal.id}`}
                        value={increaseDepositAmounts[goal.id] || ''}
                        onChange={(e) => setIncreaseDepositAmounts(prev => ({ ...prev, [goal.id]: e.target.value }))}
                        placeholder={isFullyFunded ? "Fully Funded" : "0.00"}
                        step="0.01"
                        max={remainingToFund > 0 ? remainingToFund.toFixed(USDC_DECIMALS) : undefined} // Set max attribute
                        style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }} 
                        disabled={isLoadingTx && currentDepositingGoalId === goal.id || isFullyFunded || (isConnected && activeChain && activeChain.id !== base.id) || isSwitchingNetwork}
                      />
                      <button 
                        onClick={() => handleIncreaseDeposit(goal.id, increaseDepositAmounts[goal.id] || '0')}
                        disabled={isLoadingTx || !isConnected || isFullyFunded || !isIncreaseAmountValid || (isConnected && activeChain && activeChain.id !== base.id) || isSwitchingNetwork }
                        className="button-secondary"
                        style={{ width: '100%', padding: '0.75rem', boxSizing: 'border-box' }} 
                      >
                        {isConnected && activeChain && activeChain.id !== base.id 
                          ? `Switch to ${base.name}`
                          : isSwitchingNetwork 
                            ? 'Switching Network...'
                            : isFullyFunded 
                              ? "Fully Funded" 
                              : (isLoadingTx && currentDepositingGoalId === goal.id ? 'Processing...' : 'Fund Goal')}
                      </button>
                    </div>
                  </li>
                  )}
                )}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p>{ready ? "Please log in to manage your goals." : ""}</p>
      )}
    </main>
  );
} 