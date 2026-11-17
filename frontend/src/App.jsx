import React, { useState, useEffect } from 'react';
import { 
  Building2, 
  TrendingUp, 
  RefreshCw, 
  Sun, 
  Moon, 
  AlertCircle 
} from 'lucide-react';

const API_BASE = 'http://localhost:8002/api';

export default function App() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'dark';
  });

  const [timeUnit, setTimeUnit] = useState('year'); // 'year' | 'quarter' | 'month'
  const [activeMeasure, setActiveMeasure] = useState('sales'); // 'sales' | 'collections' | 'spend' | 'surplus'
  
  const [kpis, setKpis] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [heatmapData, setHeatmapData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [hoveredBarIndex, setHoveredBarIndex] = useState(null);

  // Sync theme with localStorage
  useEffect(() => {
    localStorage.setItem('theme', theme);
  }, [theme]);

  const isDark = theme === 'dark';

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const fetchData = async (isManualRefresh = false) => {
    try {
      if (isManualRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      if (isManualRefresh) {
        await fetch(`${API_BASE}/refresh`, { method: 'POST' }).catch(() => {});
      }

      const [kpiRes, chartRes, heatRes] = await Promise.all([
        fetch(`${API_BASE}/kpis`).then(r => {
          if (!r.ok) throw new Error(`KPI API error: ${r.status}`);
          return r.json();
        }),
        fetch(`${API_BASE}/chart-data?time_unit=${timeUnit}`).then(r => {
          if (!r.ok) throw new Error(`Chart API error: ${r.status}`);
          return r.json();
        }),
        fetch(`${API_BASE}/projects-heatmap?measure=${activeMeasure}&period_type=${timeUnit}`).then(r => {
          if (!r.ok) throw new Error(`Heatmap API error: ${r.status}`);
          return r.json();
        })
      ]);

      setKpis(kpiRes);
      setChartData(chartRes);
      setHeatmapData(heatRes);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Failed to fetch live API data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [timeUnit, activeMeasure]);

  // Dynamic columns for heatmap directly from API response
  const columns = heatmapData?.columns || [];

  // Color generator for heatmap based on live values, measure, and active theme
  // Always keeps text black (or near black/gray-400 for 0), exactly matching user screenshots
  const getCellColor = (val, maxVal) => {
    // Zero or empty cell
    if (!val || val === 0) {
      return isDark ? 'bg-transparent text-gray-500' : 'bg-transparent text-gray-400';
    }

    // Collections: Shades of Blue (from soft blue to sky/periwinkle blue)
    if (activeMeasure === 'collections') {
      const ratio = Math.min(Math.max(val / (maxVal || 500), 0), 1);
      if (ratio > 0.65) {
        return isDark ? 'bg-[#3b82f6]/60 text-white font-medium' : 'bg-[#93c5fd] text-black font-normal';
      }
      if (ratio > 0.35) {
        return isDark ? 'bg-[#3b82f6]/40 text-gray-100 font-medium' : 'bg-[#bfdbfe] text-black font-normal';
      }
      return isDark ? 'bg-[#3b82f6]/20 text-gray-200' : 'bg-[#dbeafe] text-black font-normal';
    }

    // Construction Spend: Shades of Orange / Peach
    if (activeMeasure === 'spend') {
      const ratio = Math.min(Math.max(val / (maxVal || 500), 0), 1);
      if (ratio > 0.65) {
        return isDark ? 'bg-[#ea580c]/60 text-white font-medium' : 'bg-[#fba880] text-black font-normal';
      }
      if (ratio > 0.35) {
        return isDark ? 'bg-[#ea580c]/40 text-gray-100 font-medium' : 'bg-[#fed7aa] text-black font-normal';
      }
      return isDark ? 'bg-[#ea580c]/20 text-gray-200' : 'bg-[#ffedd5] text-black font-normal';
    }

    // Surplus (Collections - Spend): Red/Pink for negative (deficit), Dark Green for positive (surplus)
    if (activeMeasure === 'surplus') {
      if (val < 0) {
        return isDark 
          ? 'bg-rose-950/60 text-rose-200 font-medium' 
          : 'bg-[#fecdd3] text-black font-normal'; // soft reddish-pink with black text
      }
      const ratio = Math.min(Math.max(val / (maxVal || 500), 0), 1);
      if (ratio > 0.65) {
        return isDark ? 'bg-[#15803d]/60 text-white font-medium' : 'bg-[#86efac] text-black font-normal';
      }
      if (ratio > 0.35) {
        return isDark ? 'bg-[#15803d]/40 text-gray-100 font-medium' : 'bg-[#bbf7d0] text-black font-normal';
      }
      return isDark ? 'bg-[#15803d]/20 text-gray-200' : 'bg-[#dcfce7] text-black font-normal';
    }

    // Sales: Shades of Green / Mint (e.g. #a7f3d0, #6ee7b7)
    const ratio = Math.min(Math.max(val / (maxVal || 500), 0), 1);
    if (ratio > 0.65) {
      return isDark ? 'bg-[#059669]/60 text-white font-medium' : 'bg-[#5eead4] text-black font-normal';
    }
    if (ratio > 0.35) {
      return isDark ? 'bg-[#059669]/40 text-gray-100 font-medium' : 'bg-[#99f6e4] text-black font-normal';
    }
    return isDark ? 'bg-[#059669]/20 text-gray-200' : 'bg-[#ccfbf1] text-black font-normal';
  };

  // Find dynamic max value in current heatmap rows
  const maxHeatVal = heatmapData?.rows?.length && columns.length
    ? Math.max(...heatmapData.rows.flatMap(r => columns.map(c => r[c] || 0))) 
    : 500;

  // Chart max value calculation for bar chart scale
  const maxChartVal = chartData?.series?.length 
    ? Math.max(...chartData.series.flatMap(s => [Number(s.sales) || 0, Number(s.collections) || 0, Number(s.spend) || 0])) || 1
    : 1000;

  // Horizontal totals for heatmap (column-wise sums across all projects)
  const columnTotals = React.useMemo(() => {
    if (!heatmapData?.rows?.length || !columns.length) return {};
    const totals = {};
    columns.forEach(col => {
      totals[col] = heatmapData.rows.reduce((sum, r) => sum + (Number(r[col]) || 0), 0);
    });
    totals['grandTotal'] = heatmapData.rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    return totals;
  }, [heatmapData, columns]);

  return (
    <div className={`min-h-screen transition-colors duration-200 antialiased p-6 lg:p-8 font-sans ${
      isDark ? 'bg-[#0e121a] text-gray-200' : 'bg-gray-50 text-gray-900'
    }`}>
      {/* Top Banner: Subtitle, Sync Action & Dark/Light Switch */}
      <header className={`mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4 transition-colors ${
        isDark ? 'border-gray-800/80' : 'border-gray-200'
      }`}>
        <div>
          <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Overheads, interest, debt repayment and one-off payments. Derived from live ERP stream.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Dark / Light Mode Switch */}
          <button
            onClick={toggleTheme}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
              isDark 
                ? 'bg-gray-800/80 hover:bg-gray-700 text-amber-300 border-gray-700' 
                : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300 shadow-xs'
            }`}
            title={`Switch to ${isDark ? 'Light' : 'Dark'} Mode`}
          >
            {isDark ? (
              <>
                <Sun className="w-3.5 h-3.5 text-amber-400" />
                <span>Light mode</span>
              </>
            ) : (
              <>
                <Moon className="w-3.5 h-3.5 text-indigo-600" />
                <span>Dark mode</span>
              </>
            )}
          </button>

          {/* Sync Button */}
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer disabled:opacity-50 ${
              isDark 
                ? 'bg-gray-800/80 hover:bg-gray-700 text-gray-300 border-gray-700/80' 
                : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300 shadow-xs'
            }`}
            title="Refresh Data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Sync</span>
          </button>
        </div>
      </header>

      {error && (
        <div className={`mb-6 p-4 rounded-xl border flex items-center gap-3 text-xs ${
          isDark 
            ? 'bg-rose-950/40 border-rose-800/60 text-rose-300' 
            : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
          <span>{error}</span>
        </div>
      )}

      {/* 4 Metric Cards with dynamic period label from API */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className={`border rounded-2xl p-5 shadow-xs transition ${
          isDark ? 'bg-[#151a24] border-gray-800 hover:border-gray-700' : 'bg-white border-gray-200 hover:border-gray-300'
        }`}>
          <div className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Sales (bookings){kpis?.periodLabel ? `, ${kpis.periodLabel}` : ''}
          </div>
          <div className={`text-3xl font-bold tracking-tight mt-3 font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {kpis?.sales?.formatted || '—'}
          </div>
        </div>

        <div className={`border rounded-2xl p-5 shadow-xs transition ${
          isDark ? 'bg-[#151a24] border-gray-800 hover:border-gray-700' : 'bg-white border-gray-200 hover:border-gray-300'
        }`}>
          <div className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Collections{kpis?.periodLabel ? `, ${kpis.periodLabel}` : ''}
          </div>
          <div className={`text-3xl font-bold tracking-tight mt-3 font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {kpis?.collections?.formatted || '—'}
          </div>
        </div>

        <div className={`border rounded-2xl p-5 shadow-xs transition ${
          isDark ? 'bg-[#151a24] border-gray-800 hover:border-gray-700' : 'bg-white border-gray-200 hover:border-gray-300'
        }`}>
          <div className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Construction spend{kpis?.periodLabel ? `, ${kpis.periodLabel}` : ''}
          </div>
          <div className={`text-3xl font-bold tracking-tight mt-3 font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {kpis?.constructionSpend?.formatted || '—'}
          </div>
        </div>

        <div className={`border rounded-2xl p-5 shadow-xs transition ${
          isDark ? 'bg-[#151a24] border-gray-800 hover:border-gray-700' : 'bg-white border-gray-200 hover:border-gray-300'
        }`}>
          <div className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Project surplus{kpis?.periodLabel ? `, ${kpis.periodLabel}` : ''}
          </div>
          <div className={`text-3xl font-bold tracking-tight mt-3 font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {kpis?.projectSurplus?.formatted || '—'}
          </div>
        </div>
      </section>

      {/* Period Toggles & Measure Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className={`flex items-center border p-1 rounded-xl ${
          isDark ? 'bg-[#151a24] border-gray-800' : 'bg-gray-200/70 border-gray-300'
        }`}>
          {['year', 'quarter', 'month'].map(t => (
            <button
              key={t}
              onClick={() => setTimeUnit(t)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer ${
                timeUnit === t 
                  ? (isDark ? 'bg-white text-gray-900 shadow' : 'bg-white text-gray-900 shadow-sm')
                  : (isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900')
              }`}
            >
              By {t}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'sales', label: 'Sales' },
            { id: 'collections', label: 'Collections' },
            { id: 'spend', label: 'Construction spend' },
            { id: 'surplus', label: 'Surplus (collections – spend)' },
          ].map(m => (
            <button
              key={m.id}
              onClick={() => setActiveMeasure(m.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-xl border transition cursor-pointer ${
                activeMeasure === m.id
                  ? (isDark ? 'bg-white text-gray-900 border-white shadow' : 'bg-gray-900 text-white border-gray-900 shadow-sm')
                  : (isDark ? 'bg-[#151a24] text-gray-400 border-gray-800 hover:text-white hover:border-gray-700' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50')
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Chart Section: Group total by period */}
      <section className={`border rounded-2xl p-6 mb-8 shadow-xs transition ${
        isDark ? 'bg-[#151a24] border-gray-800' : 'bg-white border-gray-200'
      }`}>
        <div className="mb-4">
          <h2 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Group total by period
          </h2>
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {chartData?.description || 'Sales (billed demand), collections and construction spend across all projects, ₹ Cr. Hover over bars to view values.'}
          </p>
        </div>

        {/* Legend */}
        <div className={`flex items-center gap-6 text-xs font-medium mb-6 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-xs bg-[#10b981]" />
            <span>Sales</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-xs bg-[#3b82f6]" />
            <span>Collections</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-xs bg-[#ea580c]" />
            <span>Construction spend</span>
          </div>
        </div>

        {/* Responsive Bar Chart with Group Tooltip on Hover */}
        <div className={`relative pt-10 pb-2 border-b overflow-x-auto ${isDark ? 'border-gray-800/80' : 'border-gray-200'}`}>
          <div className="relative z-10 flex items-end justify-between min-w-[700px] min-h-[340px] px-6 pt-16">
            {chartData?.series?.length ? (
              chartData.series.map((item, idx) => {
                const salesVal = Number(item.sales) || 0;
                const collsVal = Number(item.collections) || 0;
                const spendVal = Number(item.spend) || 0;
                const surplusVal = Number(item.surplus) || 0;

                // Adjust tooltip position for first/last bars so it doesn't get clipped by viewport boundaries
                const tooltipAlignmentClass = idx === 0 
                  ? 'left-0 translate-x-0' 
                  : idx === chartData.series.length - 1 
                    ? 'right-0 -translate-x-0' 
                    : 'left-1/2 -translate-x-1/2';

                return (
                  <div 
                    key={idx} 
                    onMouseEnter={() => setHoveredBarIndex(idx)}
                    onMouseLeave={() => setHoveredBarIndex(null)}
                    className="flex flex-col items-center group flex-1 px-1 relative cursor-pointer"
                  >
                    {/* Floating Combined Tooltip Card on Hover */}
                    {hoveredBarIndex === idx && (
                      <div className={`absolute bottom-[102%] ${tooltipAlignmentClass} border rounded-xl p-3 shadow-2xl z-50 pointer-events-none min-w-[215px] max-w-[240px] backdrop-blur-md mb-2 ${
                        isDark ? 'bg-[#090d14]/95 border-gray-700 text-white' : 'bg-white/95 border-gray-300 text-gray-900 shadow-xl'
                      }`}>
                        <div className={`text-[11px] font-bold border-b pb-1.5 mb-2 flex items-center justify-between ${
                          isDark ? 'text-gray-200 border-gray-800' : 'text-gray-800 border-gray-200'
                        }`}>
                          <span>{item.period}</span>
                          <span className={`text-[10px] font-normal ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Data Labels</span>
                        </div>
                        <div className="space-y-1.5 text-[11px] font-mono">
                          {/* Sales Data Label */}
                          <div className="flex items-center justify-between gap-3 text-emerald-600 dark:text-emerald-400">
                            <span className={`font-sans flex items-center gap-1.5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                              Sales:
                            </span>
                            <span className="font-bold">₹{salesVal.toLocaleString()} Cr</span>
                          </div>

                          {/* Collections Data Label */}
                          <div className="flex items-center justify-between gap-3 text-blue-600 dark:text-blue-400">
                            <span className={`font-sans flex items-center gap-1.5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                              <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                              Collections:
                            </span>
                            <span className="font-bold">₹{collsVal.toLocaleString()} Cr</span>
                          </div>

                          {/* Construction Spend Data Label */}
                          <div className="flex items-center justify-between gap-3 text-orange-600 dark:text-orange-400">
                            <span className={`font-sans flex items-center gap-1.5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                              <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                              Construction:
                            </span>
                            <span className="font-bold">₹{spendVal.toLocaleString()} Cr</span>
                          </div>

                          {/* Surplus Data Label */}
                          <div className={`pt-1.5 border-t flex items-center justify-between gap-3 font-semibold ${
                            isDark ? 'border-gray-800' : 'border-gray-200'
                          }`}>
                            <span className={`font-sans ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Surplus:</span>
                            <span className={surplusVal < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-cyan-600 dark:text-cyan-300'}>
                              ₹{surplusVal.toLocaleString()} Cr
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 3 Bars */}
                    <div className={`flex items-end justify-center gap-1 w-full h-[220px] transition ${hoveredBarIndex === idx ? 'brightness-110' : ''}`}>
                      <div
                        style={{ height: `${Math.max((salesVal / maxChartVal) * 200, 6)}px` }}
                        className="w-3.5 sm:w-5 md:w-6 bg-[#10b981] rounded-t-xs transition-all hover:brightness-125"
                      />
                      <div
                        style={{ height: `${Math.max((collsVal / maxChartVal) * 200, 6)}px` }}
                        className="w-3.5 sm:w-5 md:w-6 bg-[#3b82f6] rounded-t-xs transition-all hover:brightness-125"
                      />
                      <div
                        style={{ height: `${Math.max((spendVal / maxChartVal) * 200, 6)}px` }}
                        className="w-3.5 sm:w-5 md:w-6 bg-[#ea580c] rounded-t-xs transition-all hover:brightness-125"
                      />
                    </div>

                    {/* X-Axis Label */}
                    <span className={`text-[11px] mt-3 font-medium whitespace-nowrap transition ${
                      hoveredBarIndex === idx 
                        ? (isDark ? 'text-white font-bold' : 'text-gray-900 font-bold') 
                        : (isDark ? 'text-gray-400' : 'text-gray-600')
                    }`}>
                      {item.period}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="w-full flex items-center justify-center h-48 text-gray-500 text-xs">
                No records found for period in live API payment schedule.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Heatmap Section: By project */}
      <section className={`border rounded-2xl p-6 shadow-xs transition ${
        isDark ? 'bg-[#151a24] border-gray-800' : 'bg-white border-gray-200'
      }`}>
        <div className="mb-4">
          <h2 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            By project
          </h2>
          <p className={`text-xs mt-1 max-w-5xl leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {heatmapData?.note || 'Sorted by the total for the chosen measure. Shading shows size. Values in ₹ Cr derived directly from actual API billing records.'}
          </p>
        </div>

        {/* Table Container */}
        <div className={`overflow-x-auto rounded-xl border ${isDark ? 'border-gray-800' : 'border-gray-200'}`}>
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className={`border-b font-medium ${
                isDark ? 'border-gray-800 bg-[#12161f] text-gray-400' : 'border-gray-200 bg-gray-100 text-gray-600'
              }`}>
                <th className="py-3 px-4 min-w-[220px]">Project</th>
                {columns.map(col => (
                  <th key={col} className="py-3 px-3 text-right whitespace-nowrap">{col}</th>
                ))}
                <th className={`py-3 px-4 text-right font-semibold ${isDark ? 'text-gray-300' : 'text-gray-800'}`}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody className={`divide-y font-mono ${isDark ? 'divide-gray-800/60' : 'divide-gray-200'}`}>
              {heatmapData?.rows?.map((row, idx) => (
                <tr key={idx} className={`transition ${isDark ? 'hover:bg-gray-800/30' : 'hover:bg-gray-50'}`}>
                  <td className={`py-2.5 px-4 font-sans font-medium whitespace-nowrap ${
                    isDark ? 'text-gray-200' : 'text-gray-800'
                  }`}>
                    {row.project}
                  </td>
                  {columns.map(col => (
                    <td key={col} className="p-1">
                      <div className={`py-1.5 px-2.5 rounded text-right transition ${getCellColor(row[col], maxHeatVal)}`}>
                        {(row[col] || 0).toLocaleString()}
                      </div>
                    </td>
                  ))}
                  <td className={`py-2.5 px-4 text-right font-bold whitespace-nowrap ${
                    isDark ? 'text-white' : 'text-gray-900'
                  }`}>
                    {(row.total || 0).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
            {/* Horizontal Total Row (across all projects for each period column) */}
            {heatmapData?.rows?.length > 0 && (
              <tfoot>
                <tr className={`border-t-2 font-mono font-bold ${
                  isDark 
                    ? 'border-gray-700 bg-[#12161f] text-white' 
                    : 'border-gray-300 bg-gray-100 text-gray-900'
                }`}>
                  <td className="py-3 px-4 font-sans text-xs uppercase tracking-wider">
                    Total
                  </td>
                  {columns.map(col => {
                    const colVal = Math.round((columnTotals[col] || 0) * 10) / 10;
                    return (
                      <td key={col} className="p-1">
                        <div className={`py-1.5 px-2.5 rounded text-right transition font-bold ${getCellColor(colVal, maxHeatVal)}`}>
                          {colVal.toLocaleString()}
                        </div>
                      </td>
                    );
                  })}
                  <td className={`py-3 px-4 text-right font-bold whitespace-nowrap ${
                    isDark ? 'text-amber-300' : 'text-indigo-900'
                  }`}>
                    {(Math.round((columnTotals['grandTotal'] || 0) * 10) / 10).toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}
