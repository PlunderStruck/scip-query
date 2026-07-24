import type { ScipDatabase } from '../storage/db.js';
import {
  buildReactComponentBehaviorProfiles,
  buildReactComponentBehaviorProfilesForFile,
  type ReactComponentBehaviorProfile,
  type ReactComponentProfileOptions,
} from './react-profile.js';
import { getVueSfcUnit } from './ast/vue-sfc.js';
import { buildVueScriptFacts, type VueScriptFacts } from './vue/vue-script-facts.js';
import { getVueTemplateFacts, type VueTemplateFacts } from './vue/vue-template.js';
import {
  buildVueComponentBehaviorProfile,
  buildVueComponentBehaviorProfiles,
  type VueComponentBehaviorProfile,
  type VueComponentProfileOptions,
} from './vue/vue-profile.js';

export type FrontendBehaviorSlot =
  | 'react-component-behavior-profiles'
  | 'vue-component-behavior-profiles'
  | 'vue-template-facts'
  | 'vue-script-facts';

export interface FrontendBehaviorCapability {
  slot: FrontendBehaviorSlot;
  available: boolean;
  framework: 'react' | 'vue';
  reason?: string;
}

export interface FrontendBehaviorProduct {
  capability(slot: FrontendBehaviorSlot, relativePath?: string): FrontendBehaviorCapability;
  reactProfiles(opts?: ReactComponentProfileOptions): ReactComponentBehaviorProfile[];
  reactProfilesForFile(relativePath: string): ReactComponentBehaviorProfile[];
  vueProfiles(opts?: VueComponentProfileOptions): VueComponentBehaviorProfile[];
  vueProfileForFile(relativePath: string): VueComponentBehaviorProfile;
  vueTemplateFacts(relativePath: string): VueTemplateFacts;
  vueScriptFacts(relativePath: string): VueScriptFacts;
}

export function frontendBehaviorProduct(db: ScipDatabase): FrontendBehaviorProduct {
  return {
    capability: (slot, relativePath) => frontendBehaviorCapability(slot, relativePath),
    reactProfiles: (opts = {}) => buildReactComponentBehaviorProfiles(db, opts),
    reactProfilesForFile: (relativePath) => buildReactComponentBehaviorProfilesForFile(db, relativePath),
    vueProfiles: (opts = {}) => buildVueComponentBehaviorProfiles(db, opts),
    vueProfileForFile: (relativePath) => buildVueComponentBehaviorProfile(db, relativePath),
    vueTemplateFacts: (relativePath) => getVueTemplateFacts(db, relativePath),
    vueScriptFacts: (relativePath) => buildVueScriptFacts(getVueSfcUnit(db, relativePath)),
  };
}

function frontendBehaviorCapability(
  slot: FrontendBehaviorSlot,
  relativePath: string | undefined,
): FrontendBehaviorCapability {
  const framework = slot.startsWith('react-') ? 'react' : 'vue';
  if (relativePath === undefined) return { slot, available: true, framework };
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  if (framework === 'react' && !normalized.endsWith('.tsx') && !normalized.endsWith('.jsx')) {
    return {
      slot,
      available: false,
      framework,
      reason: 'React behavior profiles are only available for .tsx and .jsx files',
    };
  }
  if (framework === 'vue' && !normalized.endsWith('.vue')) {
    return {
      slot,
      available: false,
      framework,
      reason: 'Vue behavior facts are only available for .vue files',
    };
  }
  return { slot, available: true, framework };
}
