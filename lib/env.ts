/**
 * Environment variable validation
 * Import this early in the application to catch configuration issues
 */

interface EnvConfig {
  // Required for core functionality
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;

  // Required for admin features
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ADMIN_EMAILS?: string;

  // Optional - enrichment
  NCBI_API_KEY?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateEnv(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check Supabase configuration
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || supabaseUrl === 'your-project-ref.supabase.co') {
    warnings.push('NEXT_PUBLIC_SUPABASE_URL not configured - auth features will use mock client');
  }

  if (!supabaseKey || supabaseKey === 'your-anon-key-here') {
    warnings.push('NEXT_PUBLIC_SUPABASE_ANON_KEY not configured - auth features will use mock client');
  }

  // Check service role key for admin features
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    warnings.push('SUPABASE_SERVICE_ROLE_KEY not configured - account deletion will be incomplete');
  }

  // Check admin emails
  if (!process.env.ADMIN_EMAILS && !process.env.NEXT_PUBLIC_ADMIN_EMAILS) {
    warnings.push('ADMIN_EMAILS not configured - admin dashboard will be inaccessible');
  }

  // Check optional enrichment keys
  if (!process.env.NCBI_API_KEY) {
    warnings.push('NCBI_API_KEY not configured - PubMed enrichment will use lower rate limits');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Log environment validation results
 * Call this during app initialization
 */
export function logEnvValidation(): void {
  // Only run on server
  if (typeof window !== 'undefined') return;

  const result = validateEnv();

  if (result.errors.length > 0) {
    console.error('❌ Environment configuration errors:');
    result.errors.forEach(err => console.error(`   - ${err}`));
  }

  if (result.warnings.length > 0 && process.env.NODE_ENV !== 'production') {
    console.warn('⚠️  Environment configuration warnings:');
    result.warnings.forEach(warn => console.warn(`   - ${warn}`));
  }
}

// Auto-validate on import (server-side only)
if (typeof window === 'undefined') {
  logEnvValidation();
}
