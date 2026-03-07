const path = require("path");
const { JsonFileStore } = require("./json-file");

/**
 * ProfileStore — Progressive user understanding model.
 *
 * Instead of flat key-value memories, this builds a structured portrait
 * of the user across multiple dimensions. Each trait has a confidence
 * score (0–1) that grows as evidence accumulates across conversations.
 *
 * The overall "understanding score" (0–100) reflects how well Her knows
 * the user and is visible on the home screen.
 */

const DIMENSIONS = [
  "personality",       // introvert/extrovert, decision style, temperament
  "values",            // what they care about: efficiency, creativity, relationships...
  "workStyle",         // night owl, planner, procrastinator, deep-focus...
  "emotionalPatterns", // stress reactions, what makes them happy, coping style
  "interests",         // hobbies, topics they engage with
  "lifeContext",       // career, life stage, relationships, location
  "communication",     // short/long messages, emoji usage, formality level
];

const MAX_EVIDENCE_PER_TRAIT = 8;
const MAX_TRAITS_PER_DIMENSION = 12;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function now() { return new Date().toISOString(); }

function defaultProfile() {
  const dimensions = {};
  for (const dim of DIMENSIONS) dimensions[dim] = [];
  return {
    version: 1,
    dimensions,
    understandingScore: 0,
    totalObservations: 0,
    firstSeen: null,
    lastUpdated: null,
  };
}

class ProfileStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "profile.json"), defaultProfile);
  }

  getProfile() {
    const profile = this.read();
    if (!profile.dimensions) return defaultProfile();
    return profile;
  }

  getUnderstandingScore() {
    return this.getProfile().understandingScore;
  }

  /**
   * Record one or more observations about the user.
   * Each observation: { dimension, trait, evidence, confidence? }
   *
   * - If the trait already exists, confidence grows and evidence is appended.
   * - If the trait is new, it's created with initial confidence.
   * - Contradictory traits (same dimension, opposite meaning) get reduced.
   */
  observe(observations) {
    if (!Array.isArray(observations) || observations.length === 0) return;

    const profile = this.getProfile();
    if (!profile.firstSeen) profile.firstSeen = now();
    profile.lastUpdated = now();

    for (const obs of observations) {
      if (!obs || !obs.dimension || !obs.trait) continue;
      if (!DIMENSIONS.includes(obs.dimension)) continue;

      const dim = profile.dimensions[obs.dimension] || [];
      const traitKey = obs.trait.toLowerCase().trim();
      let existing = dim.find((t) => t.trait.toLowerCase().trim() === traitKey);

      if (existing) {
        // Reinforce: increase confidence
        const boost = obs.confidence || 0.15;
        existing.confidence = clamp(existing.confidence + boost * (1 - existing.confidence), 0, 0.98);
        existing.observations += 1;
        existing.lastSeen = now();
        // Append evidence (keep last N)
        if (obs.evidence) {
          existing.evidence.push({ text: obs.evidence, time: now() });
          if (existing.evidence.length > MAX_EVIDENCE_PER_TRAIT) {
            existing.evidence = existing.evidence.slice(-MAX_EVIDENCE_PER_TRAIT);
          }
        }
      } else {
        // New trait
        const entry = {
          trait: obs.trait,
          confidence: clamp(obs.confidence || 0.3, 0.05, 0.9),
          observations: 1,
          firstSeen: now(),
          lastSeen: now(),
          evidence: obs.evidence ? [{ text: obs.evidence, time: now() }] : [],
        };
        dim.push(entry);
        // Cap traits per dimension
        if (dim.length > MAX_TRAITS_PER_DIMENSION) {
          dim.sort((a, b) => b.confidence - a.confidence);
          dim.length = MAX_TRAITS_PER_DIMENSION;
        }
      }

      profile.dimensions[obs.dimension] = dim;
    }

    profile.totalObservations += observations.filter((o) => o && o.dimension && o.trait).length;
    profile.understandingScore = this._calcScore(profile);
    this.write(profile);
    return profile;
  }

  /**
   * User explicitly confirms or denies a trait.
   */
  confirm(dimension, trait, confirmed = true) {
    const profile = this.getProfile();
    const dim = profile.dimensions[dimension] || [];
    const existing = dim.find((t) => t.trait.toLowerCase().trim() === trait.toLowerCase().trim());
    if (!existing) return profile;

    if (confirmed) {
      existing.confidence = clamp(existing.confidence + 0.3, 0, 0.98);
      existing.evidence.push({ text: "[user confirmed]", time: now() });
    } else {
      existing.confidence = clamp(existing.confidence - 0.4, 0, 0.98);
      existing.evidence.push({ text: "[user denied]", time: now() });
    }
    existing.lastSeen = now();

    // Remove trait if confidence drops too low
    profile.dimensions[dimension] = dim.filter((t) => t.confidence > 0.05);
    profile.understandingScore = this._calcScore(profile);
    profile.lastUpdated = now();
    this.write(profile);
    return profile;
  }

  /**
   * Get a summary suitable for injecting into the system prompt.
   * Only includes traits above a confidence threshold.
   */
  getPromptSummary(minConfidence = 0.25) {
    const profile = this.getProfile();
    const strong = []; // confidence >= 0.5
    const likely = []; // 0.25 <= confidence < 0.5

    const dimLabel = {
      personality: "性格上",
      values: "在意的是",
      workStyle: "做事方式",
      emotionalPatterns: "情绪上",
      interests: "兴趣方面",
      lifeContext: "生活状态",
      communication: "沟通风格",
    };

    for (const dim of DIMENSIONS) {
      const traits = (profile.dimensions[dim] || [])
        .filter((t) => t.confidence >= minConfidence)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 4);

      for (const t of traits) {
        const desc = `${dimLabel[dim] || dim}：${t.trait}`;
        if (t.confidence >= 0.5) strong.push(desc);
        else likely.push(desc);
      }
    }

    const parts = [];
    if (strong.length > 0) parts.push(`比较确定的：${strong.join("；")}`);
    if (likely.length > 0) parts.push(`可能的：${likely.join("；")}`);
    return parts.join("\n");
  }

  /**
   * Get data for the home screen display.
   */
  getHomeData() {
    const profile = this.getProfile();
    const topTraits = [];

    for (const dim of DIMENSIONS) {
      for (const trait of (profile.dimensions[dim] || [])) {
        if (trait.confidence >= 0.35) {
          topTraits.push({
            dimension: dim,
            trait: trait.trait,
            confidence: trait.confidence,
            observations: trait.observations,
          });
        }
      }
    }

    topTraits.sort((a, b) => b.confidence - a.confidence);

    return {
      score: profile.understandingScore,
      totalObservations: profile.totalObservations,
      firstSeen: profile.firstSeen,
      topTraits: topTraits.slice(0, 8),
    };
  }

  /**
   * Calculate overall understanding score (0–100).
   * Based on: how many dimensions have confident traits,
   * total observations, and average confidence.
   */
  _calcScore(profile) {
    let dimensionsWithTraits = 0;
    let totalConfidence = 0;
    let totalTraits = 0;

    for (const dim of DIMENSIONS) {
      const traits = (profile.dimensions[dim] || []).filter((t) => t.confidence >= 0.25);
      if (traits.length > 0) dimensionsWithTraits++;
      for (const t of traits) {
        totalConfidence += t.confidence;
        totalTraits++;
      }
    }

    if (totalTraits === 0) return 0;

    // Dimension coverage: 0–40 points (how many of 7 dimensions have data)
    const coverageScore = (dimensionsWithTraits / DIMENSIONS.length) * 40;

    // Depth: 0–35 points (average confidence of known traits)
    const avgConfidence = totalConfidence / totalTraits;
    const depthScore = avgConfidence * 35;

    // Volume: 0–25 points (total observations, logarithmic)
    const obs = profile.totalObservations || 0;
    const volumeScore = Math.min(25, Math.log2(obs + 1) * 4);

    return Math.round(clamp(coverageScore + depthScore + volumeScore, 0, 100));
  }
}

module.exports = { ProfileStore, DIMENSIONS };
