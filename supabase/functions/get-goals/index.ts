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
  return await crypto.subtle.importKey(
    'spki', 
    binaryDer,
    { name: 'ECDSA', namedCurve: 'P-256' }, 
    true, 
    ['verify']
  );
}

if (privyPublicKeyPem) {
  importPrivyPublicKey(privyPublicKeyPem)
    .then(key => cryptoKey = key)
    .catch(err => console.error('GET-GOALS: Failed to import Privy public key at startup:', err));
} else {
  console.error('GET-GOALS: PRIVY_PUBLIC_VERIFICATION_KEY is not set.');
}

if (!privyAppId) console.error('GET-GOALS: PRIVY_APP_ID is not set.');
if (!supabaseUrl || !supabaseServiceRoleKey) console.error('GET-GOALS: Supabase URL or Service Role Key is not set.');

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS', // Allow GET
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    });
  }

  if (!cryptoKey || !privyAppId || !supabaseUrl || !supabaseServiceRoleKey) {
    console.error('GET-GOALS: Function not properly initialized.');
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing or invalid Authorization header' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }
    const token = authHeader.split(' ')[1];

    let privyUserId: string;
    try {
      const payload = await djwt.verify(token, cryptoKey, { issuer: 'privy.io', audience: privyAppId });
      if (!payload || !payload.sub) throw new Error('Invalid token payload or missing sub claim.');
      privyUserId = payload.sub;
    } catch (e) {
      const error = e as Error;
      console.error('GET-GOALS: Token verification error:', error.message);
      return new Response(JSON.stringify({ error: 'Invalid token', details: error.message }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    // For GET requests, we don't expect a body.
    // We just fetch goals for the validated privyUserId.

    const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: goals, error: dbError } = await supabaseAdmin
      .from('goals')
      .select('*')
      .eq('user_id', privyUserId)
      .order('created_at', { ascending: false });

    if (dbError) {
      console.error('GET-GOALS: Database error:', dbError);
      return new Response(JSON.stringify({ error: 'Failed to fetch goals', details: dbError.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(goals || []), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (e) {
    const error = e as Error;
    console.error('GET-GOALS: Unhandled error:', error.message);
    return new Response(JSON.stringify({ error: 'Internal server error', details: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}); 