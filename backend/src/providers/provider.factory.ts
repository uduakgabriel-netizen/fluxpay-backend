import { JupiterAdapter } from './jupiter/jupiter.adapter';
import { JupiterMock } from './jupiter/jupiter.mock';
import { JupiterReal } from './jupiter/jupiter.real';
import { NgnAdapter } from './ngnProvider/ngn.adapter';
import { NgnMock } from './ngnProvider/ngn.mock';
import { NgnReal } from './ngnProvider/ngn.real';
import { UsdEurAdapter } from './usdEurProvider/usdeur.adapter';
import { UsdEurMock } from './usdEurProvider/usdeur.mock';
import { UsdEurReal } from './usdEurProvider/usdeur.real';

export function getProvider(type: 'jupiter'): JupiterAdapter;
export function getProvider(type: 'ngn'): NgnAdapter;
export function getProvider(type: 'usdeur'): UsdEurAdapter;
export function getProvider(type: 'jupiter' | 'ngn' | 'usdeur'): JupiterAdapter | NgnAdapter | UsdEurAdapter;
export function getProvider(type: 'jupiter' | 'ngn' | 'usdeur'): any {
  const useMock = process.env.USE_MOCK_PROVIDERS === 'true';

  if (type === 'jupiter') return useMock ? JupiterMock : JupiterReal;
  if (type === 'ngn') return useMock ? NgnMock : NgnReal;
  if (type === 'usdeur') return useMock ? UsdEurMock : UsdEurReal;

  throw new Error(`Unknown provider type: ${type}`);
}

export function getPayoutProvider(currency: string): NgnAdapter | UsdEurAdapter {
  if (currency && currency.toUpperCase() === 'NGN') {
    return getProvider('ngn');
  }
  return getProvider('usdeur');
}
