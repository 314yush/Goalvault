// supabase/functions/update-goal-funding/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from 'https://deno.land/std@0.192.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as djwt from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

// Environment Variables
const privyAppId = Deno.env.get('PRIVY_APP_ID');
const privyPublicKeyPem = Deno.env.get('PRIVY_PUBLIC_VERIFICATION_KEY');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

let cryptoKey: CryptoKey | null = null;
async function importPrivyPublicKey(pem: string): Promise<CryptoKey> {
  const pemFormatted = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n|\r/g, '');
  const binaryDer = Uint8Array.from(atob(pemFormatted), c => c.charCodeAt(0));
  return await crypto.subtle.importKey('spki', binaryDer, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

if (privyPublicKeyPem) {
  importPrivyPublicKey(privyPublicKeyPem).then(key => cryptoKey = key).catch(err => console.error('Failed to import Privy key (update-goal-funding):', err));
} else { console.error('PRIVY_PUBLIC_VERIFICATION_KEY not set (update-goal-funding).'); }
if (!privyAppId) { console.error('PRIVY_APP_ID not set (update-goal-funding).'); }
if (!supabaseUrl || !supabaseServiceRoleKey) { console.error('Supabase URL/Service Key not set (update-goal-funding).'); }

interface UpdateGoalFundingPayload {
  goal_id: string;
  deposited_amount: number;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } });
  }
  if (!cryptoKey || !privyAppId || !supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server config error' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing/invalid Authorization header' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    const token = authHeader.split(' ')[1];
    let privyUserId: string;
    try {
      const jwtPayload = await djwt.verify(token, cryptoKey, { issuer: 'privy.io', audience: privyAppId });
      if (!jwtPayload || !jwtPayload.sub) throw new Error('Invalid token payload');
      privyUserId = jwtPayload.sub;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid token', details: (e as Error).message }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (req.headers.get('content-type') !== 'application/json') {
      return new Response(JSON.stringify({ error: 'Request body must be JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    const { goal_id, deposited_amount }: UpdateGoalFundingPayload = await req.json();

    if (!goal_id || typeof deposited_amount !== 'number' || deposited_amount <= 0) {
      return new Response(JSON.stringify({ error: 'Missing goal_id or invalid/zero deposited_amount' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Fetch the current goal to ensure it exists and belongs to the user
    const { data: currentGoal, error: fetchError } = await supabaseAdmin
      .from('goals')
      .select('current_funded_amount, user_id')
      .eq('id', goal_id)
      .single();

    if (fetchError || !currentGoal) {
      return new Response(JSON.stringify({ error: 'Goal not found or failed to fetch', details: fetchError?.message }), { status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // Authorization: Check if the goal belongs to the authenticated user
    if (currentGoal.user_id !== privyUserId) {
      return new Response(JSON.stringify({ error: 'User not authorized to update this goal' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    
    const newFundedAmount = (Number(currentGoal.current_funded_amount) || 0) + deposited_amount;

    const { data: updatedGoal, error: updateError } = await supabaseAdmin
      .from('goals')
      .update({ current_funded_amount: newFundedAmount, updated_at: new Date().toISOString() })
      .eq('id', goal_id)
      .select()
      .single();

    if (updateError) {
      return new Response(JSON.stringify({ error: 'Failed to update goal funding', details: updateError.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    return new Response(JSON.stringify(updatedGoal), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Internal server error', details: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
});