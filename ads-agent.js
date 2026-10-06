const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const DEFAULT_ADS_RULES = Object.freeze({
  targetCac: 40000,
  maxDailySpend: 300000,
  maxBudgetIncreasePct: 20,
  minPurchasesForScale: 3,
  noPurchaseSpendThreshold: 100000,
});

export function calculateCampaignMetrics(campaign = {}) {
  const spend = Math.max(0, finite(campaign.spend));
  const purchases = Math.max(0, finite(campaign.purchases));
  const revenue = Math.max(0, finite(campaign.revenue));
  const impressions = Math.max(0, finite(campaign.impressions));
  const clicks = Math.max(0, finite(campaign.clicks));
  const reach = Math.max(0, finite(campaign.reach));
  return {
    id: String(campaign.id || campaign.campaignId || ''),
    name: String(campaign.name || 'Unnamed campaign'),
    status: String(campaign.status || 'UNKNOWN'),
    spend,
    purchases,
    revenue,
    impressions,
    clicks,
    reach,
    cac: purchases > 0 ? spend / purchases : null,
    roas: spend > 0 ? revenue / spend : null,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    budgetUtilization: finite(campaign.budget) > 0 ? spend / finite(campaign.budget) : null,
  };
}

export function evaluateCampaign(metrics, inputRules = {}) {
  const rules = { ...DEFAULT_ADS_RULES, ...inputRules };
  const reasons = [];
  const actions = [];
  const hasEnoughData = metrics.purchases >= rules.minPurchasesForScale;

  if (metrics.cac !== null && metrics.cac <= rules.targetCac && hasEnoughData) {
    reasons.push(`CAC ${Math.round(metrics.cac)} <= target ${rules.targetCac}`);
    actions.push({ type: 'SCALE_RECOMMENDATION', maxIncreasePct: rules.maxBudgetIncreasePct });
  }
  if (metrics.spend >= rules.noPurchaseSpendThreshold && metrics.purchases === 0) {
    reasons.push(`spend >= ${rules.noPurchaseSpendThreshold} tanpa purchase`);
    actions.push({ type: 'PAUSE_RECOMMENDATION' });
  }
  if (metrics.cac !== null && metrics.cac > rules.targetCac) {
    reasons.push(`CAC ${Math.round(metrics.cac)} > target ${rules.targetCac}`);
    actions.push({ type: 'REVIEW_RECOMMENDATION' });
  }
  return {
    qualifiesForScale: metrics.cac !== null && metrics.cac <= rules.targetCac && hasEnoughData,
    reasons,
    actions,
    ruleSnapshot: rules,
  };
}

export function analyzeCampaigns(campaigns = [], inputRules = {}) {
  if (!Array.isArray(campaigns) || campaigns.length > 100) {
    throw new Error('campaigns harus berupa array dengan maksimal 100 item');
  }
  const analyzed = campaigns.map((campaign) => {
    const metrics = calculateCampaignMetrics(campaign);
    return { ...metrics, decision: evaluateCampaign(metrics, inputRules) };
  });
  const totals = analyzed.reduce((acc, item) => ({
    spend: acc.spend + item.spend,
    purchases: acc.purchases + item.purchases,
    revenue: acc.revenue + item.revenue,
    impressions: acc.impressions + item.impressions,
    clicks: acc.clicks + item.clicks,
  }), { spend: 0, purchases: 0, revenue: 0, impressions: 0, clicks: 0 });
  return {
    schema: 'quorvante.ads-analysis.v1',
    generatedAt: new Date().toISOString(),
    campaigns: analyzed,
    totals: {
      ...totals,
      cac: totals.purchases > 0 ? totals.spend / totals.purchases : null,
      roas: totals.spend > 0 ? totals.revenue / totals.spend : null,
      ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : null,
    },
    safety: {
      mode: 'READ_ONLY',
      executionAllowed: false,
      note: 'Analisis tidak mengeksekusi perubahan pada Meta Ads.',
    },
  };
}

export function validateAdsCommand(command = '') {
  const text = String(command).trim();
  if (!text || text.length > 2000) return { ok: false, error: 'command wajib 1-2000 karakter' };
  return { ok: true, command: text };
}
