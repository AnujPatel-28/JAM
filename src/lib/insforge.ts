import { createClient } from '@insforge/sdk';

const insforgeUrl = import.meta.env.VITE_INSFORGE_URL;
const insforgeAnonKey = import.meta.env.VITE_INSFORGE_ANON_KEY;

if (!insforgeUrl || !insforgeAnonKey) {
  throw new Error(
    'Missing InsForge configuration. Copy .env.example to .env and set VITE_INSFORGE_URL and VITE_INSFORGE_ANON_KEY.'
  );
}

export const insforge = createClient({
  baseUrl: insforgeUrl,
  anonKey: insforgeAnonKey,
});

export default insforge;
