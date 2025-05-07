import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Type definition for your Database schema (optional but recommended for type safety)
// You can generate this automatically using Supabase CLI: `npx supabase gen types typescript --project-id your-project-id > lib/database.types.ts`
// For now, we'll define a basic one for the 'goals' table.
export interface Database {
  public: {
    Tables: {
      goals: {
        Row: { // The data expected from a SELECT statement
          id: string;
          user_id: string;
          title: string;
          description: string | null;
          target_amount: number;
          current_funded_amount: number;
          vault_address: string;
          created_at: string;
          updated_at: string;
        };
        Insert: { // The data expected for an INSERT statement
          id?: string; // Optional on insert as it's auto-generated
          user_id: string;
          title: string;
          description?: string | null;
          target_amount: number;
          current_funded_amount?: number; // Optional, defaults to 0
          vault_address: string;
          created_at?: string; // Optional, defaults to now()
          updated_at?: string; // Optional, defaults to now()
        };
        Update: { // The data expected for an UPDATE statement
          id?: string;
          user_id?: string;
          title?: string;
          description?: string | null;
          target_amount?: number;
          current_funded_amount?: number;
          vault_address?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Views: { [_: string]: never }; // No views defined for now
    Functions: { [_: string]: never }; // No functions defined for now
  };
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("Supabase URL is not defined in environment variables. Please set NEXT_PUBLIC_SUPABASE_URL.");
}
if (!supabaseAnonKey) {
  throw new Error("Supabase anon key is not defined in environment variables. Please set NEXT_PUBLIC_SUPABASE_ANON_KEY.");
}

// Create a single Supabase client for interacting with your database
// Pass the Database generic for type safety
export const supabase: SupabaseClient<Database> = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey
); 