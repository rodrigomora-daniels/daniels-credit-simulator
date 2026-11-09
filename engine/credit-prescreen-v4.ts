// ════════════════════════════════════════════════════════════
// DANIELS CREDIT PRE-SCREEN — SUPABASE EDGE FUNCTION  (engine v4.0, 2026-11-09)
// Aligned with Infinity X090 as programmed on 2026-11-05 (X001–X005) and
// Approvers Manual v3.0. Infinity governs; this is only an estimate.
//   X001/X002 Auto-Zone  : FICO 640+/660+, <= $1,200, 18 mo, min pmt $100
//   X003 Tier A          : FICO 640+,  <= $5,000, 18 mo, min pmt $120
//   X004 Tier B          : FICO 600+,  <= $3,500, 18 mo, min pmt $120
//   X005 Tier C          : FICO 550–599, <= $1,000, 12 mo, min pmt $120,
//                          DP 15% (score A/B) / 25% (score C)
//   Global: min DP $100. Below 550 there is NO in-house rule.
// ════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ENGINE = "v4.0-2026-11-09";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MIN_DP = 100;

const PROD = {
  furniture:   {adj:0,  minFico:550, maxIH:9999, maxDP:40, label:'Furniture',       safe:true,  flex:true,  minTerm:6,  maxTermOverride:null},
  mattress:    {adj:0,  minFico:550, maxIH:9999, maxDP:40, label:'Mattress',        safe:true,  flex:true,  minTerm:6,  maxTermOverride:null},
  accessories: {adj:0,  minFico:550, maxIH:9999, maxDP:40, label:'Accessories',     safe:true,  flex:true,  minTerm:6,  maxTermOverride:null},
  appliances:  {adj:0,  minFico:550, maxIH:9999, maxDP:45, label:'Appliances',      safe:false, flex:true,  minTerm:6,  maxTermOverride:null},
  electronics: {adj:3,  minFico:600, maxIH:2500, maxDP:50, label:'Electronics',     safe:false, flex:true,  minTerm:6,  maxTermOverride:12},
  seasonal:    {adj:8,  minFico:600, maxIH:1500, maxDP:50, label:'Seasonal',        safe:false, flex:false, minTerm:6,  maxTermOverride:12},
  iphone:      {adj:0,  minFico:600, maxIH:1000, maxDP:50, label:'iPhone / Apple',  safe:false, flex:false, minTerm:6,  maxTermOverride:12},
};

const TIER = {
  A:{maxTerm:18, maxDTI:45, maxLTV:95, apr:29, limitCap:5000, limitMult:2.0, pmtRealMin:120, maxDP:45},
  B:{maxTerm:18, maxDTI:40, maxLTV:90, apr:33, limitCap:3500, limitMult:1.5, pmtRealMin:120, maxDP:45},
  C:{maxTerm:12, maxDTI:35, maxLTV:85, apr:37, limitCap:1000, limitMult:1.5, pmtRealMin:120, maxDP:40},
};

// Tier A: Infinity "Hybrid Base" 5/5/8/10 (band breakpoints assumed 800/1500/2500 — to confirm).
// Tier B: Infinity "Hybrid Tier B" bands not yet transcribed — conservative v2 values kept.
const DP_MAT = {A:[5,5,8,10], B:[10,15,20,25]};
const DP_BRK = [800,1500,2500];
const TIER_C_DP = {good:15, weak:25}; // X005: score A/B = 15%, score C = 25%

const RANK = {A:3, B:2, C:1};

function getBaseDPpct(tier, sale, scoreTier) {
  if (tier === 'C') return scoreTier === 'C' ? TIER_C_DP.weak : TIER_C_DP.good;
  let i = sale>=DP_BRK[2]?3:sale>=DP_BRK[1]?2:sale>=DP_BRK[0]?1:0;
  return DP_MAT[tier][i];
}

function ficoBand(fico) { return fico>=640 ? 'A' : fico>=600 ? 'B' : fico>=550 ? 'C' : null; }

function combineDepartments(items) {
  if (!Array.isArray(items) || items.length === 0) {
    items = [{ product: 'furniture', amount: 0 }];
  }
  const total = items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);

  let weightedAdj = 0;
  if (total > 0) {
    for (const it of items) {
      const p = PROD[it.product];
      if (!p) continue;
      const amt = parseFloat(it.amount) || 0;
      weightedAdj += p.adj * (amt / total);
    }
  }

  const minFico = Math.max.apply(null, items.map(it => (PROD[it.product] || PROD.furniture).minFico));

  const termCaps = items
    .map(it => (PROD[it.product] || PROD.furniture).maxTermOverride)
    .filter(v => v !== null && v !== undefined);
  const maxTermOverride = termCaps.length > 0 ? Math.min.apply(null, termCaps) : null;

  const capViolations = items
    .map(it => {
      const p = PROD[it.product] || PROD.furniture;
      const amt = parseFloat(it.amount) || 0;
      return { product: it.product, amount: amt, cap: p.maxIH, overCap: amt > p.maxIH };
    })
    .filter(x => x.overCap);

  const allSafe = items.every(it => (PROD[it.product] || PROD.furniture).safe);
  const allFlex = items.every(it => (PROD[it.product] || PROD.furniture).flex);
  const maxMinTerm = Math.max.apply(null, items.map(it => (PROD[it.product] || PROD.furniture).minTerm));

  const riskiest = items
    .map(it => Object.assign({}, it, { adj: (PROD[it.product] || PROD.furniture).adj }))
    .sort((a, b) => b.adj - a.adj)[0];

  const largest = items.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];

  const maxIH = items.reduce((s, it) => {
    const p = PROD[it.product] || PROD.furniture;
    return p.maxIH >= 9999 ? s : s + p.maxIH;
  }, 0) || 9999;

  return {
    adj: weightedAdj,
    minFico: minFico,
    maxTermOverride: maxTermOverride,
    maxIH: items.some(it => (PROD[it.product] || PROD.furniture).maxIH < 9999) ? maxIH : 9999,
    safe: allSafe,
    flex: allFlex,
    minTerm: maxMinTerm,
    hasIphone: items.some(it => it.product === 'iphone'),
    label: items.length === 1
      ? (PROD[items[0].product] || PROD.furniture).label
      : items.map(it => (PROD[it.product] || PROD.furniture).label).join(' + '),
    capViolations: capViolations,
    riskiestProduct: riskiest.product,
    largestProduct: largest.product,
    items: items,
  };
}

function detectEdgeCase(fico, score, tradelines, tenure, verified, emptype, income, dpInput, sale) {
  const cases = [];
  if (tradelines === 'thin') cases.push({type:'thin', label:'Thin File', icon:'\u{1F4C4}', rule:'Limited credit history. Use verified income and tenure as substitute indicators. Same tier rules apply — the FICO band decides the path.', flex:true});
  if (tenure >= 18 && fico >= 550 && fico < 600) cases.push({type:'tenure', label:'Loyal Customer — Weak FICO', icon:'\u{1F91D}', rule:'Loyalty does NOT reduce the down payment below 600. The 550–599 path (15% / 25% DP, $1,000 max) applies as written. Flag for manager awareness.', flex:true});
  const dpPct = sale > 0 ? (dpInput/sale)*100 : 0;
  if (dpPct >= 30 && fico < 580) cases.push({type:'highdp', label:'High DP / Weak Credit', icon:'\u{1F4B5}', rule:'Large DP reduces exposure but does NOT reduce default probability. Do not use DP alone to override FICO gates. DP protects Daniels cash — it does not predict payment behavior.', flex:false});
  if (emptype === 'selfemployed') cases.push({type:'self', label:'Self-Employed', icon:'\u{1F4BC}', rule:'Treat as self-declared income regardless of documents. Not eligible for the Auto-Zone fast track. Full scoring required.', flex:false});
  if (tenure >= 24 && fico >= 600) cases.push({type:'tenure2', label:'Strong Loyalty (24+ mo)', icon:'⭐', rule:'Eligible for tenure relief on the down payment (5% floor). Highest conversion opportunity — propose best deal first.', flex:true});
  return cases;
}

function calcScore(fico, income, verified, tenure, tradelines) {
  let s = Math.min(50, Math.max(0, (fico-500)/3));
  s += tradelines==='strong'?15:tradelines==='moderate'?10:tradelines==='weak'?5:2;
  s += verified?8:0;
  s += (verified&&income>=2500)?10:(verified&&income>=1500)?5:0;
  s += tenure>=24?10:tenure>=6?5:0;
  return Math.round(s);
}
function getTier(sc){ return sc>=75?'A':sc>=60?'B':'C'; }

function calcDP(tier, sale, prod, fico, tenure, verified, scoreTier) {
  const t = TIER[tier];
  const isI = !!prod.hasIphone;
  const base = getBaseDPpct(tier, sale, scoreTier);
  const adj = prod.adj;
  let relief = 0;
  if (fico>=600 && !isI) {
    if (tenure>=12) relief=10;
    else if (tenure>=6) relief=5;
  }
  let raw = Math.max(relief>0 ? 5 : 0, base+adj-relief);
  if (isI) raw = Math.max(25, raw);
  raw = Math.min(raw, Math.min(prod.maxDP || 50, t.maxDP));
  const reqD = Math.max(isI ? Math.round(0.25*sale) : MIN_DP, Math.round(raw/100*sale), MIN_DP);
  return {pct:raw, dollar:reqD, base:base, adj:adj, relief:relief, fr:fico>=550&&fico<600, isI:isI};
}

function fitTermToMinPmt(fin, apr, term, minPmt) {
  let t = term;
  while (t > 3 && calcMonthlyPayment(fin, apr, t) < minPmt) t--;
  return t;
}

function checkGuardrails(tier, prod, sale, dpInput, term, monthly, income, debts, financed) {
  const t = TIER[tier];
  const warnings = [];
  const effectiveTerm = prod.maxTermOverride ? Math.min(term, prod.maxTermOverride) : term;
  const maxTerm = Math.min(t.maxTerm, prod.maxTermOverride || 999);
  if (term > maxTerm) warnings.push('Term ' + term + 'mo exceeds max ' + maxTerm + 'mo for ' + prod.label + ' Tier ' + tier + '. Reduced to ' + maxTerm + 'mo.');
  if (monthly > 0 && monthly < t.pmtRealMin && financed >= t.pmtRealMin) warnings.push('Payment $' + Math.round(monthly) + '/mo is below the $' + t.pmtRealMin + ' program minimum. Shorten term.');
  const dti = income>0 ? ((monthly+debts)/income)*100 : 999;
  if (dti > t.maxDTI) warnings.push('DTI ' + dti.toFixed(0) + '% exceeds Tier ' + tier + ' max ' + t.maxDTI + '%. Deal not realistically sellable.');
  const ltv = sale>0 ? (financed/sale)*100 : 0;
  if (ltv > t.maxLTV) warnings.push('LTV ' + ltv.toFixed(0) + '% exceeds Tier ' + tier + ' max ' + t.maxLTV + '%. Increase DP.');
  if (income > 1500 && debts < income * 0.22) {
    warnings.push('⚠ Monthly obligations ($' + Math.round(debts).toLocaleString() + ') appear low for this income level. Confirm rent, car payment, and all recurring debts are included.');
  }
  return { warnings:warnings, dti:dti, ltv:ltv, dtiOK:dti<=t.maxDTI, ltvOK:ltv<=t.maxLTV, effectiveTerm:effectiveTerm };
}

function findSalvage(tier, sale, prod, fico, tenure, verified, income, debts, emptype, scoreTier) {
  const t = TIER[tier];
  const maxT = prod.maxTermOverride ? Math.min(t.maxTerm, prod.maxTermOverride) : t.maxTerm;
  const maxDPdollar = Math.min(sale * 0.35, income * 1.0, 1200);
  const dpBase = calcDP(tier, sale, prod, fico, tenure, verified, scoreTier).dollar;
  for (let dp=dpBase; dp<=maxDPdollar; dp+=50) {
    const fin = Math.max(0, sale-dp);
    const lim = Math.min(t.limitCap, income*t.limitMult);
    if (fin>lim||fin>prod.maxIH) continue;
    const ltv = sale>0?(fin/sale)*100:0;
    if (ltv>t.maxLTV) continue;
    const salvAPR = calcAPR(tier, prod.riskiestProduct || 'furniture', verified, emptype);
    for (let tm=maxT; tm>=3; tm-=1) {
      const pmt = calcMonthlyPayment(fin, salvAPR, tm);
      if (pmt<t.pmtRealMin && fin>=t.pmtRealMin) continue;
      const dti = income>0?((pmt+debts)/income)*100:999;
      if (dti<=t.maxDTI) return {dp:Math.round(dp), term:tm, pmt:Math.round(pmt), financed:Math.round(fin), dti:dti.toFixed(0), apr:salvAPR};
    }
  }
  return null;
}

function buildSplit(tier, sale, dpInput, fico, income, prod) {
  if (!tier || fico < 550) return null; // no in-house rule below 550
  const caps = {A:5000,B:3500,C:1000};
  const danielsCap = Math.min(caps[tier], income*TIER[tier].limitMult, prod.maxIH);
  const danielsAmt = Math.min(danielsCap, Math.max(0, sale-dpInput));
  if (danielsAmt<300) return null;
  const extAmt = Math.max(0, sale-dpInput-danielsAmt);
  if (extAmt<150) return null;
  return {danielsAmt:Math.round(danielsAmt), extAmt:Math.round(extAmt), partner:fico<600?'SNAP / Koalafi':'Synchrony / WF'};
}

function genSalesScript(cls, decision, dp, monthly, term, salvage, split, fico, prodLabel, shortfall) {
  const pname = prodLabel || 'item';
  const scripts = {
    approved: {
      quote: '"Based on what you’ve shared, this looks like a strong fit for our financing program. You’d likely need $' + (dp||0).toLocaleString() + ' down, and the payment would be around $' + (monthly||0).toLocaleString() + ' a month for ' + term + ' months. Does that sound workable?"',
      steps: [
        {n:1, t:'Confirm the estimated down payment', d:'<strong>$' + (dp||0).toLocaleString() + ' down</strong> is the likely requirement. Let the customer know this is the amount needed at the time of contract signing.'},
        {n:2, t:'Review the estimated monthly payment', d:'Around <strong>$' + (monthly||0).toLocaleString() + ' per month</strong> for ' + term + ' months. Confirm this fits their budget before moving forward.'},
        {n:3, t:'Next step: formal application', d:'This pre-screen looks favorable. Move to the full application process — customer will need ID, utility bill, and pay stub. Verify the down payment and documents yourself; do not rely on the system approval alone.'},
      ]
    },
    adjust: {
      quote: salvage
        ? '"This could work with a small adjustment. If you’re able to put $' + (salvage.dp||0).toLocaleString() + ' down, the estimated payment would be around $' + (salvage.pmt||0).toLocaleString() + ' a month for ' + salvage.term + ' months. Is that something you could manage?"'
        : '"This is close — a small adjustment to the down payment or term could make it work. Want to explore the options?"',
      steps: salvage ? [
        {n:1, t:'Estimated down payment: $' + (salvage.dp||0).toLocaleString(), d:'This is the amount that makes in-house financing likely viable. Ask: <strong>"Could you bring $' + (salvage.dp||0).toLocaleString() + ' at the time of purchase?"</strong>'},
        {n:2, t:'Suggested term: ' + salvage.term + ' months', d:'Estimated payment: <strong>$' + (salvage.pmt||0).toLocaleString() + '/month</strong>. This structure keeps the deal within program guidelines.'},
        {n:3, t:"If the down payment isn't available", d:'A split financing option or an external partner may be worth exploring instead.'},
      ] : [
        {n:1, t:'A higher down payment would help', d:'Around $' + (shortfall||0).toLocaleString() + ' more would improve the likely outcome significantly. Ask if that’s feasible.'},
        {n:2, t:'Consider a shorter term', d:'A shorter repayment period can bring the deal into a viable range. Try adjusting by 6 months.'},
        {n:3, t:'Or consider a smaller purchase', d:'A lower purchase price may qualify more cleanly for in-house financing.'},
      ]
    },
    split: {
      quote: split
        ? '"There’s a financing option that could work well here — we’d handle $' + (split.danielsAmt||0).toLocaleString() + ' through our program, and a partner would cover the rest. You’d still be able to take your ' + pname + ' home. Want me to explain how that would look?"'
        : '"A split financing approach might be the best fit here — part through our program and part through a partner. Want to hear how it works?"',
      steps: split ? [
        {n:1, t:'Our program: estimated $' + (split.danielsAmt||0).toLocaleString(), d:'This is the portion we’d likely finance in-house. Standard program terms would apply.'},
        {n:2, t:'Partner program: estimated $' + (split && split.extAmt || 0).toLocaleString() + ' via ' + (split && split.partner || 'financing partner'), d:'We’d submit a separate application to ' + (split && split.partner || 'our financing partner') + ' for this portion. Fast process.'},
        {n:3, t:'Both agreements needed at time of purchase', d:'Final approval from both programs is required before goods are released. This is confirmed at the formal application stage.'},
      ] : []
    },
    external: {
      quote: fico < 600
        ? '"Based on your profile, one of our financing partners would likely be the best fit for this deal. They work with a wide range of situations and it’s a straightforward process. Would you like me to point you in that direction?"'
        : '"For a deal like this, our financing partner Synchrony is likely the strongest option. They have competitive programs and the process is usually fast. Interested in exploring that?"',
      steps: [
        {n:1, t:'Likely path: ' + (fico<600?'SNAP / Koalafi':'Synchrony / WF'), d:'Based on this pre-screen, an external financing partner is the most likely fit. We’d refer you to their program for a full application.'},
        {n:2, t:'Set the right expectation', d:"Let the customer know this is a partner program — separate from our in-house financing, but still a good option."},
        {n:3, t:'Note the pre-screen result', d:'Record this outcome so the approver has context when the formal application comes in.'},
      ]
    },
    declined: {
      quote: '"Based on what you’ve shared, our financing programs may not be the best fit right now. I want to be straightforward about that, but I also want to make sure you know what your options are going forward."',
      steps: [
        {n:1, t:'Share the result clearly and respectfully', d:'This is a pre-screen result, not a permanent decision. The customer is not being declined from everything — just from the current program under current conditions.'},
        {n:2, t:'Give a simple, non-technical reason', d:'Example: "Our program has specific requirements that aren’t matched right now." Do <strong>not</strong> reference internal score thresholds.'},
        {n:3, t:'Offer a constructive path forward', d:'If an external option like SNAP is available, mention it. Otherwise, suggest steps that could improve the profile over time.'},
      ]
    },
  };
  return scripts[cls] || scripts.external;
}

function calcAPR(tier, productKey, verified, emptype){
  let a=TIER[tier].apr;
  if(productKey==='electronics'||productKey==='iphone')a+=1;
  if(!verified||emptype==='selfemployed')a+=3;
  return Math.min(a,42);
}

function calcMonthlyPayment(financed, aprPct, termMonths) {
  if (!financed || financed <= 0 || !termMonths || termMonths <= 0) return 0;
  const r = (aprPct / 100) / 12;
  if (r <= 0) return Math.round(financed / termMonths);
  const pmt = (financed * r) / (1 - Math.pow(1 + r, -termMonths));
  return Math.round(pmt);
}


// ───────── Infinity risk score (InfinityX Risk Score Rules, new customers) ─────────
function infinityScoreNew(fico, open, pastDue, judg, fore) {
  if (fico < 530) return {score:'D', why:'FICO under 530'};
  if (pastDue > 3) return {score:'D', why:'More than 3 past-due trade lines'};
  if (judg > 0) return {score:'D', why:'Judgment in the last 12 months'};
  if (fore > 0) return {score:'D', why:'Foreclosure in the last 12 months'};
  if (fico >= 625 && open >= 3) return {score:'A', why:'FICO 625+ and 3+ open accounts'};
  if (fico >= 600 && open >= 2) return {score:'B', why:'FICO 600+ and 2+ open accounts'};
  if (fico >= 531 && open >= 2) return {score:'C', why:'FICO 531+ and 2+ open accounts'};
  return {score:'U', why: open < 2 ? 'Fewer than 2 open accounts' : 'FICO too low'};
}

function deriveOpen(inputs) {
  const v = parseInt(inputs.openAccts);
  if (!isNaN(v)) return v;
  const t = inputs.tradelines;
  return t==='strong'?5 : t==='moderate'?3 : t==='weak'?2 : 1;
}

const UNKNOWNS = [
  'Tier A / Tier B down-payment bands (using $800/$1,500/$2,500 breakpoints for A; older values for B) until transcribed from Infinity.',
  'Auto-Zone (X001/X002) down payment table not transcribed — using the Tier A/B tables.',
  'C992 (Credit Line) eligibility rules not documented — modeled as: existing customer with enough available credit line, $100 down, 18 months, ignores the risk score.',
  'C983 (High Fico) credit-line formula is not in the documentation — amount limit not modeled.',
  'How Infinity ranks offers into "Best Offer" is not documented — lowest down payment, then longest term, is assumed.',
];

function evalOffers(c, score) {
  const offers = [];
  const fico=c.fico, sale=c.sale, combo=c.combo, f=c.flags;
  const clean = !f.delinq10 && !f.unpaid && !f.cosigner;
  const merchOK = combo.capViolations.length === 0;
  const policyOK = fico >= combo.minFico;
  const policyWhy = policyOK ? '' : combo.label + ' is not allowed under FICO ' + combo.minFico + ' by Daniels policy (Infinity does not enforce this).';

  function hybrid(rule, name, minF, maxF, scores, cap, maxTermRule, pmtMin, tier, extraOK, extraWhy) {
    const why = [];
    if (fico < minF || fico > maxF) why.push('FICO '+fico+' outside '+minF+(maxF<900?'–'+maxF:'+'));
    if (scores.indexOf(score) < 0) why.push('Infinity score '+score+' (needs '+scores.join('/')+')');
    if (!clean) why.push('Exclusion: delinquent >10 days, unpaid returned check/NSF/late charge, or co-signer');
    if (!merchOK) why.push('A department is over its own cap');
    if (!extraOK) why.push(extraWhy);
    const d = calcDP(tier, sale, combo, fico, c.tenure, c.verified, score);
    const dpFit = Math.max(d.dollar, Math.ceil(sale - cap));
    if (dpFit > sale*0.5) why.push('Amount over the $'+cap.toLocaleString()+' rule cap');
    const fin = Math.max(0, sale - dpFit);
    const maxT = Math.min(maxTermRule, combo.maxTermOverride || 99);
    const apr = calcAPR(tier, combo.riskiestProduct, c.verified, c.emptype);
    const term = fitTermToMinPmt(fin, apr, Math.min(c.termReq || maxT, maxT), pmtMin);
    offers.push({rule:rule, name:name, native:false, eligible:why.length===0, why:why, dp:dpFit, dpPct:Math.round(dpFit/Math.max(sale,1)*100), baseDp:d.dollar, adjusted:dpFit>d.dollar, term:term, maxTerm:maxT, pmt:calcMonthlyPayment(fin,apr,term), financed:fin, cap:cap, apr:apr, tier:tier, policyOK:policyOK, policyWhy:policyWhy});
  }
  const azTier = score==='A' ? 'A' : 'B';
  hybrid('X001','Auto-Zone (external)',660,900,['A','B'],1200,18,100,azTier, combo.safe && !combo.hasIphone && c.emptype!=='selfemployed', 'Auto-Zone excludes self-employed, iPhone and non-furniture departments');
  hybrid('X002','Auto-Zone (internal)',640,900,['A'],1200,18,100,'A', combo.safe && !combo.hasIphone, 'Auto-Zone excludes iPhone and non-furniture departments');
  hybrid('X003','Tier A',640,900,['A'],5000,18,120,'A', true, '');
  hybrid('X004','Tier B',600,900,['A','B'],3500,18,120,'B', true, '');
  hybrid('X005','Tier C',550,599,['A','B','C'],1000,12,120,'C', true, '');

  // Native C983 High Fico
  {
    const why=[];
    const g1 = fico>=700 && score==='A' && f.open>=5;
    const g2 = fico>=650 && (score==='A'||score==='B') && !f.late30 && f.open>=5;
    if (!(g1||g2)) why.push('Needs FICO 700+ & score A & 5+ open trades, or FICO 650+ & score A/B & no 30-day lates in 12 months & 5+ open trades');
    if (f.delinq10||f.unpaid||f.cosigner||f.judgBig||f.foreclosure) why.push('Exclusion (delinquent >10 days, unpaid returned check/NSF/late charges, judgment >$1,000, foreclosure, or co-signer)');
    if (sale - MIN_DP > 5000) why.push('Amount above $5,000 \u2014 the High Fico credit-line formula is not documented; verify in Infinity');
    const fin = Math.max(0, sale - MIN_DP);
    const apr = calcAPR('A', combo.riskiestProduct, c.verified, c.emptype);
    const term = Math.min(c.termReq || 24, 24);
    offers.push({rule:'C983', name:'High Fico (native)', native:true, eligible:why.length===0, why:why, dp:MIN_DP, dpPct:Math.round(MIN_DP/Math.max(sale,1)*100), baseDp:MIN_DP, adjusted:false, term:term, maxTerm:24, pmt:calcMonthlyPayment(fin,apr,term), financed:fin, cap:null, apr:apr, tier:'A', policyOK:true, policyWhy:''});
  }
  // Native C992 Credit Line
  {
    const why=[];
    if (!c.existing) why.push('Only existing customers with a credit line');
    else if (!(c.creditLine > 0)) why.push('No available credit line entered');
    else if (sale - MIN_DP > c.creditLine) why.push('Amount exceeds the available credit line ($'+Math.round(c.creditLine).toLocaleString()+')');
    const fin = Math.max(0, sale - MIN_DP);
    const apr = calcAPR('B', combo.riskiestProduct, c.verified, c.emptype);
    offers.push({rule:'C992', name:'Credit Line (native)', native:true, eligible:why.length===0, why:why, dp:MIN_DP, dpPct:Math.round(MIN_DP/Math.max(sale,1)*100), baseDp:MIN_DP, adjusted:false, term:18, maxTerm:18, pmt:calcMonthlyPayment(fin,apr,18), financed:fin, cap:c.creditLine||null, apr:apr, tier:null, policyOK:false, policyWhy:'Credit Line approves regardless of risk score, FICO or product. Not a Hybrid policy approval.'});
  }
  return offers;
}

function pickBest(list) {
  return list.slice().sort((a,b)=> (a.dp-b.dp) || (b.term-a.term))[0] || null;
}

const C992_ALERT = '⚠ Infinity’s native Credit Line rule (C992) can auto-approve a customer even when this pre-screen says external. A system approval is NOT proof the deal fits policy — always verify the down payment, ID and income before releasing goods.';

function calculate(inputs) {
  const fico     = parseInt(inputs.fico);
  const income   = parseFloat(inputs.income)||0;
  const tax      = parseFloat(inputs.tax)||0;
  const tenure   = parseInt(inputs.tenure)||0;
  const dpInput  = parseFloat(inputs.dpInput)||0;
  const termReq  = parseInt(inputs.termReq);
  const debts    = parseFloat(inputs.debts)||0;
  const emptype  = inputs.emptype;
  const verified = inputs.verified !== false;
  const priorDef = inputs.priorDef === true;
  const existing = inputs.custType === 'existing';
  const creditLine = parseFloat(inputs.creditLine)||0;
  const open = deriveOpen(inputs);
  const flags = {
    open: open,
    delinq10: inputs.delinq10 === true,
    unpaid: inputs.unpaid === true,
    cosigner: inputs.cosigner === true,
    judgBig: inputs.judgBig === true,
    foreclosure: inputs.foreclosure === true,
    late30: inputs.late30 === true,
  };

  const rawItems = Array.isArray(inputs.items) && inputs.items.length > 0
    ? inputs.items
    : [{ product: inputs.product || 'furniture', amount: parseFloat(inputs.purchase) || 0 }];
  const purchase = rawItems.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
  const sale     = purchase*(1+tax/100);
  const combo = combineDepartments(rawItems);
  const isI  = combo.hasIphone;
  const edgeCases = detectEdgeCase(fico, 0, inputs.tradelines, tenure, verified, emptype, income, dpInput, sale);

  const steps = []; const guardrailAlerts = [];
  const SKIP_ALL = ['FICO Gate','Score & Tier','Deal Context','Product Risk','Down Payment','Term & Payment','Structure Check','Likely Path'];
  const base = (o)=>Object.assign({engine:ENGINE,steps:steps,edgeCases:edgeCases,guardrailAlerts:guardrailAlerts,sale:sale,dpInput:dpInput,unknowns:UNKNOWNS},o);

  let hs = null;
  if (isNaN(fico) || fico < 300 || fico > 850) hs='Enter a valid FICO score (300–850).';
  else if (priorDef) hs='Prior Daniels charge-off / default on file — Infinity scores this customer D (no hybrid offer).';
  else if (sale <= 0) hs='Enter the purchase amount.';

  if (hs) {
    steps.push({s:'fail',n:'Hard Stops',d:'HARD STOP — Cannot process',note:hs});
    SKIP_ALL.forEach(n=>steps.push({s:'skip',n:n,d:'Skipped',note:''}));
    if (priorDef) guardrailAlerts.push(C992_ALERT);
    const decision='NOT VIABLE — Hard Stop';
    return base({decision:decision,cls:'declined',tier:null,score:null,infinityScore:'D',dp:null,dpPct:null,term:null,pmt:null,limit:null,apr:null,salvage:null,split:null,routing:fico<550?'snap':'external',dti:null,ltv:null,dtiOK:null,ltvOK:null,dpShort:0,financed:0,reqDP:0,offers:[],script:genSalesScript('declined',decision,0,0,0,null,null,fico,combo.label,0)});
  }
  steps.push({s:'pass',n:'Hard Stops',d:'Clear — no disqualifying flags',note:'No prior Daniels default.'});

  // ── Infinity risk score ──
  let score, scoreWhy, scoreKnown = true, scenarios = null;
  if (existing) {
    const ov = String(inputs.scoreOverride||'').toUpperCase();
    if (['A','B','C','D','U'].indexOf(ov) >= 0) { score = ov; scoreWhy = 'Score read from the customer’s Infinity account'; }
    else {
      scoreKnown = false;
      score = fico>=625?'A':fico>=600?'B':'C';
      scoreWhy = 'Existing customer — score depends on Daniels payment history. Shown as a clean-history estimate; check the real score in Infinity.';
    }
  } else {
    const r = infinityScoreNew(fico, open, parseInt(inputs.pastDue)||0, parseInt(inputs.judgments)||0, parseInt(inputs.foreclosures)||0);
    score = r.score; scoreWhy = r.why;
  }
  const ctx = {fico:fico,sale:sale,combo:combo,tenure:tenure,verified:verified,emptype:emptype,termReq:termReq,flags:flags,existing:existing,creditLine:creditLine};
  let offers = evalOffers(ctx, score);
  if (!scoreKnown) {
    scenarios = {};
    ['A','B','C'].forEach(sc=>{ const o=evalOffers(ctx,sc).filter(x=>x.eligible && x.policyOK); const b=pickBest(o); scenarios[sc]= b?{rule:b.rule,dp:b.dp,term:b.term,pmt:b.pmt}:null; });
  }

  // ── FICO gate step ──
  if (fico < 550) {
    steps.push({s:'fail',n:'FICO Gate',d:'FICO '+fico+' — Below the 550 in-house minimum',note:'No Hybrid rule applies under 550 (~27% of new sub-600 accounts go 61+ days late).'});
  } else if (fico < 600) {
    steps.push({s:'warn',n:'FICO Gate',d:'FICO '+fico+' — Restricted Path (550–599, rule X005)',note:'About 12.5–13% of accounts here go 61+ days late. Max $1,000 financed, 12 months, 15% down (25% if score C), furniture/mattress/appliances only, no loyalty relief.'});
  } else {
    const label = fico<640?'Tier B range (600–639)':fico<680?'Tier A range (640–679)':fico<700?'Normal (680–699)':'Preferred (700+)';
    steps.push({s:'pass',n:'FICO Gate',d:'FICO '+fico+' — '+label,note: fico<680 ? 'About 2.9% 61+ delinquency on auto-approved, 4.5% on manually approved accounts at 600–679.' : 'Lower-risk band.'});
  }
  steps.push({s:(score==='A'||score==='B'||score==='C')?'info':'fail',n:'Score & Tier',d:'Infinity score '+score+(existing?' (existing customer)':' (new customer)'),note:scoreWhy+'. Hybrid rules need score A/B/C; X003 needs A, X004 needs A/B, X005 accepts A/B/C.'+(scenarios?' If the account score is different: A → '+(scenarios.A?scenarios.A.rule+' $'+scenarios.A.dp+' down':'no offer')+' · B → '+(scenarios.B?scenarios.B.rule+' $'+scenarios.B.dp+' down':'no offer')+' · C → '+(scenarios.C?scenarios.C.rule+' $'+scenarios.C.dp+' down':'no offer')+'.':'')});

  const ruleLines = offers.filter(o=>!o.native).map(o=>o.rule+(o.eligible?' ✓':' ✗')).join('  ');
  steps.push({s:'info',n:'Deal Context',d:'Rules evaluated: '+ruleLines+'  '+offers.filter(o=>o.native).map(o=>o.rule+(o.eligible?' ✓':' ✗')).join('  '),note:'Infinity tests every rule and shows the offers it finds, with one marked Best Offer.'});

  // product step
  if (combo.capViolations.length > 0) {
    const v = combo.capViolations[0]; const vLabel=(PROD[v.product]||PROD.furniture).label;
    steps.push({s:'fail',n:'Product Risk',d:vLabel+' exceeds its own cap',note:'$'+v.amount.toLocaleString()+' in '+vLabel+' exceeds the $'+v.cap.toLocaleString()+' cap for that category.'});
  } else if (fico < combo.minFico) {
    steps.push({s:'fail',n:'Product Risk',d:combo.label+' — not allowed under FICO '+combo.minFico,note:'Daniels policy. Infinity may still show an offer — do not rely on it.'});
  } else {
    steps.push({s:'pass',n:'Product Risk',d:combo.label+(combo.adj>0?' (+'+combo.adj.toFixed(0)+'% DP)':' (no DP adj)'),note:isI?'⚠ iPhone in cart: 25% DP min, max $1,000, 12-month term.':'Product mix approved for in-house evaluation.'});
  }

  const hybridOK = offers.filter(o=>!o.native && o.eligible);
  const pool = offers.filter(o=>o.eligible && o.policyOK);
  const best = pickBest(pool);
  const c992 = offers.find(o=>o.rule==='C992' && o.eligible);
  const sysBest = pickBest(offers.filter(o=>o.eligible));

  if (c992 || !pool.length) guardrailAlerts.push(C992_ALERT);
  if (c992 && best && c992.dp < best.dp) guardrailAlerts.push('Infinity may show $'+c992.dp+' down (Credit Line C992) as its Best Offer. Policy down payment for this deal is $'+best.dp+' — collect that amount.');
  if (hybridOK.length && !pool.length) guardrailAlerts.push('Infinity would offer this deal ('+hybridOK[0].rule+'), but Daniels policy prohibits it. A system offer here is NOT an approval.');
  if (emptype==='none') guardrailAlerts.push('No verifiable income source — the approver will require income documentation.');
  if (inputs.inquiries === true) guardrailAlerts.push('5+ credit inquiries in 12 months — approver risk flag.');
  if (fico >= 600 && score==='C') guardrailAlerts.push('Score C at FICO 600+: Infinity has no automatic rule for this — expect manual review.');

  const reqProbe = best || hybridOK[0] || offers.find(o=>o.rule==='X005');
  let decision, cls, routing, salvage=null, split=null, finalDP, finalTerm, finalPmt, finalFinanced, reqDP, reqDPpct, tierOut=null, apr=null, limit=null;
  if (best) {
    reqDP=best.dp; reqDPpct=best.dpPct; finalFinanced=best.financed; finalTerm=best.term; finalPmt=best.pmt; apr=best.apr; limit=best.cap; tierOut=best.tier; finalDP=Math.max(dpInput,best.dp);
    const dpOK = dpInput >= best.dp;
    steps.push({s:dpOK?'pass':'warn',n:'Down Payment',d:'Required: $'+best.dp.toLocaleString()+' ('+best.dpPct+'%) · Customer has: $'+dpInput.toLocaleString(),note:'Rule '+best.rule+(best.adjusted?' — raised to fit the $'+(best.cap||0).toLocaleString()+' cap.':'.')+' Absolute minimum $'+MIN_DP+'.'+(isI?' iPhone: 25% minimum.':'')});
    const dti = income>0 ? ((best.pmt+debts)/income)*100 : null;
    steps.push({s:'pass',n:'Term & Payment',d:'Term: '+best.term+'mo · Pmt: $'+best.pmt+'/mo'+(dti!==null?' · Payment-to-income: '+dti.toFixed(0)+'%':''),note:'APR ~'+best.apr+'% · Max term '+best.maxTerm+'mo · payment is raised to the rule minimum, which shortens the term.'});
    steps.push({s:'skip',n:'Structure Check',d:best.adjusted?'Down payment raised to fit rule cap':'Not needed — deal pre-qualifies as-is',note:''});
    if (best.native) { decision='LIKELY IN-HOUSE — Infinity High-Fico Auto-Approval'; cls='approved'; }
    else if (best.rule==='X001'||best.rule==='X002') { decision='LIKELY IN-HOUSE — Streamlined'; cls = (dpOK&&!best.adjusted)?'approved':'adjust'; if(cls==='adjust') decision='LIKELY IN-HOUSE — With Adjustments'; }
    else if (best.rule==='X005') { decision='LIKELY IN-HOUSE — With Adjustments'; cls='adjust'; }
    else { decision = (dpOK&&!best.adjusted)?'LIKELY IN-HOUSE':'LIKELY IN-HOUSE — With Adjustments'; cls = (dpOK&&!best.adjusted)?'approved':'adjust'; }
    routing='inhouse';
    if (cls==='adjust') salvage={dp:best.dp,term:best.term,pmt:best.pmt,financed:best.financed,dti:dti!==null?dti.toFixed(0):'—',apr:best.apr};
    steps.push({s:'pass',n:'Likely Path',d:'In-house — rule '+best.rule+' ('+best.name+')',note:'Estimate based on the Infinity rules as programmed. Final approval still requires the formal application and approver verification.'});
  } else {
    reqDP = reqProbe ? reqProbe.dp : 0; reqDPpct = reqProbe ? reqProbe.dpPct : 0; finalDP=dpInput; finalTerm=null; finalPmt=null; finalFinanced=0;
    const why = (reqProbe && !reqProbe.eligible) ? reqProbe.why.join('; ') : 'No Hybrid rule matches this profile.';
    steps.push({s:'warn',n:'Down Payment',d:'No in-house offer',note:why});
    const sp = (fico>=550 && (score==='A'||score==='B'||score==='C') && fico>=combo.minFico) ? buildSplit(fico>=640?'A':fico>=600?'B':'C',sale,Math.max(dpInput,reqDP*0.5),fico,income||99999,combo) : null;
    if (sp) { split=sp; decision='LIKELY SPLIT TENDER'; cls='split'; routing='split'; steps.push({s:'sv',n:'Structure Check',d:'✦ SPLIT TENDER — partial in-house possible',note:'Daniels: $'+sp.danielsAmt.toLocaleString()+' · '+sp.partner+': $'+sp.extAmt.toLocaleString()+'. Only if the in-house piece fits the rule cap on its own.'}); steps.push({s:'info',n:'Likely Path',d:'SPLIT — In-house + External most likely',note:''}); }
    else {
      const ep = fico < 600 ? 'SNAP / Koalafi' : 'Synchrony / WF';
      routing = fico < 600 ? 'snap' : 'external'; decision='LIKELY EXTERNAL — '+ep; cls='external';
      steps.push({s:'warn',n:'Structure Check',d:'No viable in-house structure found',note:'All Hybrid rules and native rules evaluated.'});
      steps.push({s:'warn',n:'Likely Path',d:'EXTERNAL — '+ep+' most likely',note: why});
    }
  }

  const dti = (best && income>0) ? ((best.pmt+debts)/income)*100 : null;
  const sc = genSalesScript(cls,decision,finalDP||reqDP,finalPmt,finalTerm,salvage,split,fico,combo.label,Math.max(0,reqDP-dpInput));
  return base({decision:decision,cls:cls,tier:tierOut,score:null,infinityScore:score,scoreWhy:scoreWhy,scoreKnown:scoreKnown,scenarios:scenarios,dp:finalDP||reqDP,dpPct:reqDPpct,term:finalTerm,pmt:finalPmt,limit:limit,apr:apr,salvage:salvage,split:split,routing:routing,dti:dti,ltv:null,dtiOK:null,ltvOK:null,dpShort:Math.max(0,reqDP-dpInput),financed:finalFinanced,reqDP:reqDP,offers:offers,infinityBestOffer:sysBest?{rule:sysBest.rule,dp:sysBest.dp,term:sysBest.term}:null,policyOffer:best?{rule:best.rule,dp:best.dp,term:best.term,pmt:best.pmt}:null,script:sc});
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const inputs = await req.json();
    const result = calculate(inputs);

    return new Response(JSON.stringify(result), {
      headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
      status: 400,
    });
  }
});
