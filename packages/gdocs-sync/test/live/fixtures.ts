/**
 * Durable, UI-decorated fixture docs. Tests READ these; they must
 * never modify, recreate, or delete them. Decorations (anchored
 * comments, suggested edits) were made by hand in the Docs UI —
 * the API cannot create them (probed; see margin#10).
 *
 * CP-ANCHORS: four anchored comments (paragraph, list item, table
 * cell, single word — quotedFileContent matches the fixture text),
 * three suggested edits (insert / delete / replace), one checkbox.
 * Probed ground truth: UI comments carry `anchor` (opaque kix.* id);
 * suggestions appear as suggestedInsertionIds/suggestedDeletionIds
 * on text runs.
 *
 * Checkbox finding (probed after UI check): the checked item exposes
 * NOTHING via the API — no run strikethrough, no bullet/list marker.
 * UI-checked state without struck text is unreadable; only strike-
 * encoded checks (our write path, and UI checklists that strike their
 * text) round-trip. Recorded as a known API-level loss.
 */
export const CP_ANCHORS_FIXTURE_DOC_ID = '1gRN3xsJ7nE_0DNOUnwYD_8jIQqnC_afv2P_54IZq1K4';
