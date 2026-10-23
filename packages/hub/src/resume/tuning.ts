/**
 * 2.3 The thresholds behind every résumé line. Nothing is a model's opinion: these constants turn judged results into words.
 *
 *  - A task type needs `minRuns` graded runs before the résumé says anything about it.
 *  - Strong: mean quality >= strongQuality and first-pass acceptance >= strongFirstPass.
 *  - Weak: mean quality < weakQuality, or at least `weakSentBack` of its tasks were sent back after the first attempt.
 *  - Version-aware (2.4): when the agent's current model version has `minRuns` graded runs of its own on a task type, the
 *    line is about that version alone (the model name is shown); until then earlier versions' runs count too.
 *  - At most `maxLines` strengths and weaknesses are written, strongest and weakest first.
 */
export const RESUME_TUNING = {
  minRuns: 3,
  strongQuality: 0.8,
  strongFirstPass: 0.7,
  weakQuality: 0.6,
  weakSentBack: 0.5,
  maxLines: 3,
  maxLessons: 3,
  /** Task types listed in the table (the rest are summed up in one line). */
  maxTypes: 12,
};

/** RESUME.md is capped at 8 KB and condensed from 80% of it (CONTROL.md section 5). */
export const RESUME_CAP = 8 * 1024;
export const CONDENSE_AT = 0.8;
