"use client"; // Required for PrivyProvider and hooks

import React from 'react';
import { PrivyProvider, type PrivyClientConfig } from '@privy-io/react-auth'; // Import PrivyClientConfig type
import { WagmiProvider } from '@privy-io/wagmi'; // Import from @privy-io/wagmi
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApolloProvider } from "@apollo/client"; // Added
import { apolloClient } from "../lib/apolloClient"; // Added
import { base } from 'viem/chains'; // Assuming Base chain for now
import { http } from 'wagmi';
import { createConfig } from '@privy-io/wagmi'; // Import from @privy-io/wagmi
import '../styles/globals.css'; // Import global styles

// 1. Create wagmi config
const wagmiConfig = createConfig({
  chains: [base],
  transports: {
    [base.id]: http('https://mainnet.base.org'),
  },
});

// 2. Create a new QueryClient instance
const queryClient = new QueryClient();

// 3. Privy App ID (replace with your actual App ID, possibly from .env)
const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || 'YOUR_PRIVY_APP_ID';

// 4. Privy-specific configuration
const privyClientConfig: PrivyClientConfig = {
  loginMethods: ['email', 'wallet', 'google', 'github'],
  appearance: {
    theme: 'dark',
    accentColor: '#676FFF',
  },
  embeddedWallets: {
    createOnLogin: 'users-without-wallets',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <PrivyProvider
          appId={privyAppId}
          config={privyClientConfig} // Pass Privy-specific config
        >
          <QueryClientProvider client={queryClient}>
            <ApolloProvider client={apolloClient}> {/* Added Wrapper */}
              <WagmiProvider config={wagmiConfig}> {/* Use wagmiConfig from @privy-io/wagmi */}
                {children}
              </WagmiProvider>
            </ApolloProvider> {/* Added Wrapper */}
          </QueryClientProvider>
        </PrivyProvider>
      </body>
    </html>
  );
} 