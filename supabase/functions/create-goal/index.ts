// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

import { serve } from 'https://deno.land/std@0.192.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as djwt from 'https://deno.land/x/djwt@v3.0.2/mod.ts'; // Using djwt for JWT verification

// Define a basic type for the expected request body
interface CreateGoalPayload {
  title: string;
  description?: string;
  target_amount: number;
  vault_address: string;
  end_date?: string;
}

// Environment Variables (ensure these are set in Supabase Edge Function settings)
const privyAppId = Deno.env.get('PRIVY_APP_ID');
const privyPublicKeyPem = Deno.env.get('PRIVY_PUBLIC_VERIFICATION_KEY'); // Expecting the full PEM string
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

let cryptoKey: CryptoKey | null = null;

async function importPrivyPublicKey(pem: string): Promise<CryptoKey> {
  // Remove PEM header and footer and whitespace
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

// Pre-import the key if available at startup
if (privyPublicKeyPem) {
  importPrivyPublicKey(privyPublicKeyPem)
    .then(key => cryptoKey = key)
    .catch(err => console.error('Failed to import Privy public key at startup:', err));
} else {
  console.error('PRIVY_PUBLIC_VERIFICATION_KEY is not set in environment variables.');
}

if (!privyAppId) {
  console.error('PRIVY_APP_ID is not set in environment variables.');
}
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('Supabase URL or Service Role Key is not set.');
}

serve(async (req: Request) => {
  // Handle CORS preflight requests with more explicit headers and status
  if (req.method === 'OPTIONS') {
    return new Response('ok', { 
      status: 200, // Explicitly set 200 OK status
      headers: {
        'Access-Control-Allow-Origin': '*', 
        'Access-Control-Allow-Methods': 'POST, OPTIONS', // Specify allowed methods
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    });
  }

  // Ensure critical env vars are loaded, and key is imported before proceeding
  if (!cryptoKey || !privyAppId || !supabaseUrl || !supabaseServiceRoleKey) {
    console.error('Function not properly initialized due to missing env vars or failed key import.');
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    // 1. Extract Authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing or invalid Authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const token = authHeader.split(' ')[1];

    // 2. Verify the JWT
    let privyUserId: string;
    try {
      const payloadVerify = await djwt.verify(token, cryptoKey, {
        issuer: 'privy.io',
        audience: privyAppId,
      });
      if (!payloadVerify || !payloadVerify.sub) {
        throw new Error('Invalid token payload or missing sub claim.');
      }
      privyUserId = payloadVerify.sub; 
    } catch (e) {
      const error = e as Error;
      console.error('Token verification error:', error.message, e);
      return new Response(JSON.stringify({ error: 'Invalid token', details: error.message }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 3. Parse the request body for goal details
    if (req.headers.get('content-type') !== 'application/json') {
      return new Response(JSON.stringify({ error: 'Request body must be JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const payload: CreateGoalPayload = await req.json();
    const { title, description, target_amount, vault_address, end_date } = payload;

    if (!title || typeof target_amount !== 'number' || !vault_address) {
      return new Response(JSON.stringify({ error: 'Missing required fields: title, target_amount, vault_address' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    
    if (end_date && isNaN(new Date(end_date).getTime())) {
        return new Response(JSON.stringify({ error: 'Invalid end_date format. Please use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ).' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            status: 400,
        });
    }

    // 4. Initialize Supabase client with SERVICE_ROLE_KEY
    const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey);

    // CHECK FOR DUPLICATE GOAL TITLE for this user
    const { data: existingGoals, error: selectError } = await supabaseAdmin
      .from('goals')
      .select('id, title')
      .eq('user_id', privyUserId)
      .eq('title', title)
      .limit(1);

    if (selectError) {
      console.error('CREATE-GOAL: Error checking for existing goals:', selectError);
    }

    if (existingGoals && existingGoals.length > 0) {
      console.log('CREATE-GOAL: Duplicate goal title found for user:', privyUserId, title);
      return new Response(JSON.stringify({ error: 'A goal with this title already exists.' }), {
        status: 409, // Conflict
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 5. Insert the goal into the database
    const insertPayload = {
      user_id: privyUserId,
      title,
      description: description || null,
      target_amount,
      vault_address,
      end_date: end_date ? new Date(end_date).toISOString() : null
    };

    const { data: newGoal, error: dbError } = await supabaseAdmin
      .from('goals')
      .insert(insertPayload)
      .select()
      .single();

    if (dbError) {
      console.error('CREATE-GOAL: Database error on insert:', dbError);
      if (dbError.code === '23505') {
        return new Response(JSON.stringify({ error: 'A goal with this title already exists (DB constraint).' }), {
            status: 409, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      return new Response(JSON.stringify({ error: 'Failed to create goal', details: dbError.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 6. Return the created goal
    return new Response(JSON.stringify(newGoal), {
      status: 201, // Created
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (e) {
    const error = e as Error;
    console.error('CREATE-GOAL: Unhandled error:', error.message, e);
    return new Response(JSON.stringify({ error: 'Internal server error', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/create-goal' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
