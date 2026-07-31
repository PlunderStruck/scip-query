import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  deriveMissionEffectiveness,
  invalidMissionEffectiveness,
  unavailableMissionEffectiveness,
  type MissionEffectivenessEvidence,
} from '../domain/mission-effectiveness.js';
import {
  MISSION_TRIAL_PROGRAMS_DIR,
  assertProtectedRootOutsideCandidate,
  readMissionTrialProgramFile,
  readMissionTrialRuns,
} from '../storage/mission-trials.js';

export interface MissionEffectivenessLoadOptions {
  programPath?: string;
  protectedRoot?: string;
  candidateRoot: string;
}

export function loadMissionEffectiveness(options: MissionEffectivenessLoadOptions): MissionEffectivenessEvidence {
  if (!options.programPath && !options.protectedRoot) {
    return unavailableMissionEffectiveness(
      'No protected mission-trial program was supplied; autonomous-completion effectiveness is not evaluated.',
    );
  }
  if (!options.programPath || !options.protectedRoot) {
    return invalidMissionEffectiveness(
      'Mission effectiveness requires both --mission-trial-program and --mission-trial-root.',
    );
  }
  try {
    assertProtectedRootOutsideCandidate(options.protectedRoot, options.candidateRoot);
    const decoded = readMissionTrialProgramFile(resolve(options.programPath));
    if (decoded.state !== 'current') {
      return invalidMissionEffectiveness(`Mission trial program is ${decoded.state}: ${decoded.error}`);
    }
    const protectedRoot = realpathSync(options.protectedRoot);
    const programPath = realpathSync(options.programPath);
    const expectedProgramPath = realpathSync(
      join(protectedRoot, MISSION_TRIAL_PROGRAMS_DIR, `${decoded.record.programId}.json`),
    );
    if (programPath !== expectedProgramPath) {
      return invalidMissionEffectiveness(
        'Mission trial program must be the immutable program record registered under the protected root.',
      );
    }
    const runs = readMissionTrialRuns(protectedRoot, decoded.record.programId);
    const issues = runs.issues.map((issue) => `${issue.path}: ${issue.state}: ${issue.reason}`);
    return deriveMissionEffectiveness(decoded.record, runs.records, issues);
  } catch (error) {
    return invalidMissionEffectiveness(error instanceof Error ? error.message : String(error));
  }
}
