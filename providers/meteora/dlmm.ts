// providers/meteora/dlmm.ts
// Lazy DLMM SDK loader and DLMM-specific utilities (price conversion, program ID).
// Extracted from tx.ts to keep SDK concerns separate from transaction helpers.

let _DLMM: any = null;
let _StrategyType: any = null;
let _getBinIdFromPrice: any = null;
let _getPriceOfBinByBinId: any = null;
let _getBinArrayKeysCoverage: any = null;
let _getBinArrayIndexesCoverage: any = null;
let _deriveBinArrayBitmapExtension: any = null;
let _isOverflowDefaultBinArrayBitmap: any = null;
let _BIN_ARRAY_FEE: any = null;
let _BIN_ARRAY_BITMAP_FEE: any = null;
let _calculateSpotDistribution: any = null;
let _calculateBidAskDistribution: any = null;
let _calculateNormalDistribution: any = null;

export async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = (mod.default as any)?.getBinIdFromPrice ?? (mod as any).getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
    _calculateSpotDistribution = mod.calculateSpotDistribution;
    _calculateBidAskDistribution = mod.calculateBidAskDistribution;
    _calculateNormalDistribution = mod.calculateNormalDistribution;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
    calculateSpotDistribution: _calculateSpotDistribution,
    calculateBidAskDistribution: _calculateBidAskDistribution,
    calculateNormalDistribution: _calculateNormalDistribution,
  };
}

import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

export function decimalPriceToQ64(priceStr: string): BN {
  if (!priceStr || priceStr === "0") return new BN(0);
  const s = String(priceStr);
  const dot = s.indexOf(".");
  if (dot === -1) return new BN(s).shln(64);
  const intPart = s.slice(0, dot);
  const fracPart = s.slice(dot + 1);
  const combined = intPart + fracPart;
  const decimals = fracPart.length;
  return new BN(combined).mul(new BN(1).shln(64)).div(new BN(10).pow(new BN(decimals)));
}

export function getDlmmProgramId(): PublicKey {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}
