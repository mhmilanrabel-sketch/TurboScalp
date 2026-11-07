import React, { useState } from 'react';
import { X, Calculator, DollarSign, Shield, Target, ArrowRight } from 'lucide-react';

interface RiskCalculatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultPrice?: number;
  accountBalance: number;
}

export const RiskCalculatorModal: React.FC<RiskCalculatorModalProps> = ({
  isOpen,
  onClose,
  defaultPrice = 90000,
  accountBalance,
}) => {
  const [balance, setBalance] = useState<number>(accountBalance || 10000);
  const [riskPct, setRiskPct] = useState<number>(1.5);
  const [entryPrice, setEntryPrice] = useState<number>(defaultPrice);
  const [stopLossPrice, setStopLossPrice] = useState<number>(
    Number((defaultPrice * 0.992).toFixed(2))
  );
  const [targetPrice, setTargetPrice] = useState<number>(
    Number((defaultPrice * 1.018).toFixed(2))
  );

  if (!isOpen) return null;

  const dollarRisk = (balance * riskPct) / 100;
  const priceDistance = Math.abs(entryPrice - stopLossPrice) || 1;
  const slPct = ((priceDistance / entryPrice) * 100).toFixed(2);

  // Position Size Calculation
  const positionSizeUnits = dollarRisk / priceDistance;
  const positionSizeUsd = positionSizeUnits * entryPrice;
  const recommendedLeverage = Math.min(50, Math.max(1, Math.ceil(positionSizeUsd / balance)));

  const rewardDistance = Math.abs(targetPrice - entryPrice);
  const riskReward = (rewardDistance / priceDistance).toFixed(2);
  const potentialProfitUsd = (positionSizeUnits * rewardDistance).toFixed(2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold">
              <Calculator className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Binance Pro Risk Calculator</h2>
              <span className="text-[10px] text-slate-400">Position Sizing & Capital Preservation</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-4 space-y-4 text-xs">
          {/* Account Balance & Risk % */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                Account Equity (USDT)
              </label>
              <input
                type="number"
                value={balance}
                onChange={(e) => setBalance(Number(e.target.value))}
                className="w-full bg-slate-950 text-white font-mono font-bold p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                Risk Per Trade (%)
              </label>
              <input
                type="number"
                step="0.5"
                min="0.2"
                max="10"
                value={riskPct}
                onChange={(e) => setRiskPct(Number(e.target.value))}
                className="w-full bg-slate-950 text-amber-400 font-mono font-bold p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          {/* Entry, SL, TP */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-slate-400 block mb-1">Entry Price</label>
              <input
                type="number"
                step="any"
                value={entryPrice}
                onChange={(e) => setEntryPrice(Number(e.target.value))}
                className="w-full bg-slate-950 text-white font-mono font-bold p-2 rounded-xl border border-slate-700"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-rose-400 block mb-1">Stop Loss</label>
              <input
                type="number"
                step="any"
                value={stopLossPrice}
                onChange={(e) => setStopLossPrice(Number(e.target.value))}
                className="w-full bg-slate-950 text-rose-300 font-mono font-bold p-2 rounded-xl border border-slate-700"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-emerald-400 block mb-1">Target Price</label>
              <input
                type="number"
                step="any"
                value={targetPrice}
                onChange={(e) => setTargetPrice(Number(e.target.value))}
                className="w-full bg-slate-950 text-emerald-300 font-mono font-bold p-2 rounded-xl border border-slate-700"
              />
            </div>
          </div>

          {/* Calculated Output Matrix */}
          <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Total Dollar Risk (Max Loss):</span>
              <span className="font-mono font-bold text-rose-400">-${dollarRisk.toFixed(2)} USDT</span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Position Notional Value:</span>
              <span className="font-mono font-bold text-slate-100">${positionSizeUsd.toFixed(2)} USDT</span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Position Size (Tokens):</span>
              <span className="font-mono font-bold text-amber-400">{positionSizeUnits.toFixed(4)} units</span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Recommended Safe Leverage:</span>
              <span className="font-mono font-bold text-indigo-400">{recommendedLeverage}x</span>
            </div>

            <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-800">
              <span className="text-emerald-400 font-semibold">Potential Profit (TP):</span>
              <span className="font-mono font-bold text-emerald-400">+${potentialProfitUsd} USDT</span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-amber-400 font-semibold">Risk-to-Reward Ratio:</span>
              <span className="font-mono font-bold text-amber-400">{riskReward} : 1</span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold transition-all text-xs"
          >
            Apply & Close
          </button>
        </div>
      </div>
    </div>
  );
};
