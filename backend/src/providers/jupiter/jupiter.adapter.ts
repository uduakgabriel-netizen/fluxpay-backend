export interface JupiterSwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

export interface JupiterSwapQuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  route: any;
}

export interface BuildSwapTxParams {
  sourceMint: string;
  destinationMint: string;
  amount: string;
  userPublicKey?: string;
  slippageBps?: number;
}

export interface BuildSwapTxResult {
  serializedTransaction: string;
}

export interface SubmitSwapResult {
  txHash: string;
}

export interface JupiterAdapter {
  getSwapQuote(params: JupiterSwapQuoteParams): Promise<JupiterSwapQuoteResult>;
  buildSwapTransaction(params: BuildSwapTxParams): Promise<BuildSwapTxResult>;
  submitSwap(signedTransaction: string): Promise<SubmitSwapResult>;
}
