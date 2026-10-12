import dotenv from '@dotenvx/dotenvx';
dotenv.config({ path: ['.env.local', '.env'] });

import { TokenService } from '../src/services/token.service';

async function seed() {
  console.log('Seeding tokens...');
  await TokenService.refreshTokenCache();
  console.log('Done!');
  process.exit(0);
}

seed().catch(console.error);
