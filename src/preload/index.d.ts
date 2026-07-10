import type { MarginApi } from './index';

declare global {
  interface Window {
    margin: MarginApi;
  }
}

export {};
