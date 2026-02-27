export const ANALYTICS_EVENT_NAMES = [
  'signup_completed',
  'first_score_loaded',
  'upload_success',
  'editor_revision_saved',
  'catalog_search_performed',
  'score_viewed',
  'revision_commented',
  'revision_rated',
  'score_downloaded',
  'score_editor_session_started',
  'score_editor_iframe_loaded',
  'score_editor_session_ended',
  'score_editor_runtime_loaded',
  'score_editor_document_loaded',
  'score_editor_document_load_failed',
  'score_editor_ai_request',
  'score_editor_patch_applied',
  'score_editor_session_summary'
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export const ANALYTICS_EVENT_NAME_SET = new Set<string>(ANALYTICS_EVENT_NAMES);

export const ANALYTICS_SOURCE_APPS = [
  'frontend',
  'backend',
  'score_editor_api'
] as const;

export type AnalyticsSourceApp = (typeof ANALYTICS_SOURCE_APPS)[number];

export const ANALYTICS_SOURCE_APP_SET = new Set<string>(ANALYTICS_SOURCE_APPS);

export const MAX_INGEST_EVENTS_PER_REQUEST = 50;
export const MAX_PROPERTIES_BYTES = 8 * 1024;

export const ANALYTICS_DOWNLOAD_FORMATS = [
  'pdf',
  'musicxml',
  'mxl',
  'mscz',
  'mscx',
  'midi',
  'png',
  'svg',
  'other'
] as const;

export type AnalyticsDownloadFormat = (typeof ANALYTICS_DOWNLOAD_FORMATS)[number];

export const ANALYTICS_DOWNLOAD_FORMAT_SET = new Set<string>(ANALYTICS_DOWNLOAD_FORMATS);
