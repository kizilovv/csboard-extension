// ============================================================
// Pattern Detection — ported from cs2trader utilsModular.js
// Detects: Fade %, Marble Fade pattern, Case Hardened blue %
// ============================================================

import { FadeCalculator } from 'csgo-fade-percentage-calculator';
// @ts-ignore — JS files without types
import patterns from './patterns.js';
// @ts-ignore — JSON import
import bluePercentage from './bluepercent.json';

export interface PatternInfo {
  type: 'fade' | 'marble_fade' | 'case_hardened';
  value: string;
  percentage?: number;
  short?: number | string;
}

// cs2trader exact: order matters — M9 Bayonet before Bayonet
const chKnifeNames: [string, string][] = [
  ['M9 Bayonet', 'M9_Bayonet'],
  ['Bayonet', 'Bayonet'],
  ['Bowie Knife', 'Bowie_Knife'],
  ['Butterfly Knife', 'Butterfly_Knife'],
  ['Classic Knife', 'Classic_Knife'],
  ['Falchion Knife', 'Falchion_Knife'],
  ['Flip Knife', 'Flip_Knife'],
  ['Gut Knife', 'Gut_Knife'],
  ['Huntsman Knife', 'Huntsman_Knife'],
  ['Karambit', 'Karambit'],
  ['Kukri Knife', 'Kukri_Knife'],
  ['Navaja Knife', 'Navaja_Knife'],
  ['Nomad Knife', 'Nomad_Knife'],
  ['Paracord Knife', 'Paracord_Knife'],
  ['Shadow Daggers', 'Shadow_Daggers'],
  ['Skeleton Knife', 'Skeleton_Knife'],
  ['Stiletto Knife', 'Stiletto_Knife'],
  ['Survival Knife', 'Survival_Knife'],
  ['Talon Knife', 'Talon_Knife'],
  ['Ursus Knife', 'Ursus_Knife'],
];

// cs2trader exact: getPattern(name, paintSeed)
export const getPattern = (name: string, paintSeed: number | null): PatternInfo | null => {
  if (!name || paintSeed === null || paintSeed === undefined) return null;

  // --- Marble Fade ---
  if (name.includes(' Marble Fade ')) {
    let pattern: string | null = null;
    const mf = patterns.marble_fades;
    if (name.includes('Karambit')) pattern = mf.karambit?.[paintSeed] ?? null;
    else if (name.includes('Butterfly')) pattern = mf.butterfly?.[paintSeed] ?? null;
    else if (name.includes('M9 Bayonet')) pattern = mf.m9?.[paintSeed] ?? null;
    else if (name.includes('Bayonet')) pattern = mf.bayonet?.[paintSeed] ?? null;
    else if (name.includes('Talon')) pattern = mf.talon?.[paintSeed] ?? null;
    else if (name.includes('Stiletto')) pattern = mf.stiletto?.[paintSeed] ?? null;
    else if (name.includes('Navaja')) pattern = mf.navaja?.[paintSeed] ?? null;
    else if (name.includes('Ursus')) pattern = mf.ursus?.[paintSeed] ?? null;
    else if (name.includes('Huntsman')) pattern = mf.huntsman?.[paintSeed] ?? null;
    else if (name.includes('Flip')) pattern = mf.flip?.[paintSeed] ?? null;
    else if (name.includes('Bowie')) pattern = mf.bowie?.[paintSeed] ?? null;
    else if (name.includes('Daggers')) pattern = mf.daggers?.[paintSeed] ?? null;
    else if (name.includes('Gut')) pattern = mf.gut?.[paintSeed] ?? null;
    else if (name.includes('Falchion')) pattern = mf.falchion?.[paintSeed] ?? null;
    else return null;

    if (pattern) return { type: 'marble_fade', value: pattern, short: pattern };
    return null;
  }

  // --- Fade % ---
  if (name.includes(' Fade ')) {
    let percentage: number | null = null;
    try {
      if (name.includes('Karambit')) percentage = FadeCalculator.getFadePercentage('Karambit', paintSeed).percentage;
      else if (name.includes('Butterfly Knife')) percentage = FadeCalculator.getFadePercentage('Butterfly Knife', paintSeed).percentage;
      else if (name.includes('M9 Bayonet')) percentage = FadeCalculator.getFadePercentage('M9 Bayonet', paintSeed).percentage;
      else if (name.includes('Bayonet')) percentage = FadeCalculator.getFadePercentage('Bayonet', paintSeed).percentage;
      else if (name.includes('Talon Knife')) percentage = FadeCalculator.getFadePercentage('Talon Knife', paintSeed).percentage;
      else if (name.includes('Stiletto Knife')) percentage = FadeCalculator.getFadePercentage('Stiletto Knife', paintSeed).percentage;
      else if (name.includes('Navaja Knife')) percentage = FadeCalculator.getFadePercentage('Navaja Knife', paintSeed).percentage;
      else if (name.includes('Ursus Knife')) percentage = FadeCalculator.getFadePercentage('Ursus Knife', paintSeed).percentage;
      else if (name.includes('Huntsman Knife')) percentage = FadeCalculator.getFadePercentage('Huntsman Knife', paintSeed).percentage;
      else if (name.includes('Flip Knife')) percentage = FadeCalculator.getFadePercentage('Flip Knife', paintSeed).percentage;
      else if (name.includes('Bowie Knife')) percentage = FadeCalculator.getFadePercentage('Bowie Knife', paintSeed).percentage;
      else if (name.includes('Shadow Daggers')) percentage = FadeCalculator.getFadePercentage('Shadow Daggers', paintSeed).percentage;
      else if (name.includes('Gut Knife')) percentage = FadeCalculator.getFadePercentage('Gut Knife', paintSeed).percentage;
      else if (name.includes('Falchion Knife')) percentage = FadeCalculator.getFadePercentage('Falchion Knife', paintSeed).percentage;
      else if (name.includes('Classic Knife')) percentage = FadeCalculator.getFadePercentage('Classic Knife', paintSeed).percentage;
      else if (name.includes('Nomad Knife')) percentage = FadeCalculator.getFadePercentage('Nomad Knife', paintSeed).percentage;
      else if (name.includes('Paracord Knife')) percentage = FadeCalculator.getFadePercentage('Paracord Knife', paintSeed).percentage;
      else if (name.includes('Skeleton Knife')) percentage = FadeCalculator.getFadePercentage('Skeleton Knife', paintSeed).percentage;
      else if (name.includes('Survival Knife')) percentage = FadeCalculator.getFadePercentage('Survival Knife', paintSeed).percentage;
      else if (name.includes('Kukri Knife')) percentage = FadeCalculator.getFadePercentage('Kukri Knife', paintSeed).percentage;
      else if (name.includes('Glock-18')) percentage = FadeCalculator.getFadePercentage('Glock-18', paintSeed).percentage;
      else if (name.includes('AWP')) percentage = FadeCalculator.getFadePercentage('AWP', paintSeed).percentage;
      else if (name.includes('MAC-10')) percentage = FadeCalculator.getFadePercentage('MAC-10', paintSeed).percentage;
      else if (name.includes('MP7')) percentage = FadeCalculator.getFadePercentage('MP7', paintSeed).percentage;
      else if (name.includes('R8 Revolver')) percentage = FadeCalculator.getFadePercentage('R8 Revolver', paintSeed).percentage;
      else if (name.includes('UMP-45')) percentage = FadeCalculator.getFadePercentage('UMP-45', paintSeed).percentage;
      else if (name.includes('M4A1-S')) percentage = FadeCalculator.getFadePercentage('M4A1-S', paintSeed).percentage;
      else return null;
    } catch {
      return null;
    }

    if (percentage !== null && percentage !== undefined) {
      return {
        type: 'fade',
        value: `${percentage.toFixed(2)}% Fade`,
        percentage,
        short: Math.floor(percentage),
      };
    }
    return null;
  }

  // --- Case Hardened blue % ---
  if (name.includes(' Case Hardened')) {
    let pattern: string | null = null;
    const bp = bluePercentage as Record<string, any>;

    for (const [knifeName, key] of chKnifeNames) {
      if (name.startsWith(`★ ${knifeName} `) || name.startsWith(`★ StatTrak™ ${knifeName} `)) {
        const data = bp[key];
        if (data) {
          const playside = data.playside?.[paintSeed] ?? '?';
          const backside = data.backside?.[paintSeed] ?? '?';
          pattern = `${playside}%/${backside}%`;
        }
        break;
      }
    }

    if (!pattern && name.includes('AK-47')) pattern = patterns.case_hardeneds?.ak?.[paintSeed] ?? null;
    else if (!pattern && name.includes('Five-SeveN')) pattern = patterns.case_hardeneds?.five_seven?.[paintSeed] ?? null;

    if (pattern) return { type: 'case_hardened', value: pattern, short: pattern };
    return null;
  }

  return null;
};
