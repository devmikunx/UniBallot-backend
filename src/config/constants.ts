export const OTP_EXPIRY_MINUTES     = 10;
export const OTP_MAX_ATTEMPTS       = 5;
export const OTP_RESEND_MAX_ATTEMPTS = 3;
export const OTP_RESEND_INTERVAL_SECONDS = 60;
export const REFRESH_TOKEN_EXPIRY_DAYS = 7;
export const ELECTION_CODE_LENGTH   = 8;
export const MAX_UPLOAD_SIZE_BYTES  = 2_097_152;
export const ALLOWED_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const MATRIC_NUMBER_REGEX = /^20\d{6}$/;

export const ELECTION_STATUS_ORDER = [
  'draft',
  'setup',
  'registration_open',
  'registration_closed',
  'voting_open',
  'paused',
  'voting_closed',
  'results_published',
] as const;

export type ElectionStatus = (typeof ELECTION_STATUS_ORDER)[number];

export const CLOUDINARY_FOLDERS = {
  AVATARS:    'election-app/avatars',
  CANDIDATES: 'election-app/candidates',
} as const;

export const AUDIT_ACTIONS = {
  USER_REGISTERED:               'user_registered',
  PROFILE_COMPLETED:             'profile_completed',
  OFFICER_CREATED:               'officer_created',
  ACCOUNT_SUSPENDED:             'account_suspended',
  ACCOUNT_ACTIVATED:             'account_activated',
  ACCOUNT_DELETED:               'account_deleted',
  PASSWORD_RESET:                'password_reset',
  ASSOCIATION_CREATED:           'association_created',
  ASSOCIATION_UPDATED:           'association_updated',
  ASSOCIATION_DELETED:           'association_deleted',
  ELECTION_CREATED:              'election_created',
  ELECTION_DELETED:              'election_deleted',
  OFFICER_ASSIGNED:              'officer_assigned',
  MEMBERS_UPLOADED:              'members_uploaded',
  MEMBERS_CLEARED:               'members_cleared',
  MEMBER_UPDATED:                'member_updated',
  MEMBER_DELETED:                'member_deleted',
  OFFICE_CREATED:                'office_created',
  OFFICE_DELETED:                'office_deleted',
  CANDIDATE_ADDED:               'candidate_added',
  CANDIDATE_REMOVED:             'candidate_removed',
  STATUS_CHANGED:                'status_changed',
  LOCKDOWN_ACTIVATED:            'lockdown_activated',
  LOCKDOWN_DEACTIVATED:          'lockdown_deactivated',
  VOTER_REGISTERED:              'voter_registered',
  VOTE_SUBMITTED:                'vote_submitted',
  RESULTS_PUBLISHED:             'results_published',
  SEMESTER_RESET_INITIATED:      'semester_reset_initiated',
  SEMESTER_RESET_COMPLETED:      'semester_reset_completed',
  INTEGRITY_CHECK_RUN:           'integrity_check_run',
  CACHE_FLUSHED:                 'cache_flushed',
  ANON_ELECTION_CREATED:         'anon_election_created',
  ANON_VOTE_SUBMITTED:           'anon_vote_submitted',
  CANDIDATE_EDITED_DURING_PAUSE: 'candidate_edited_during_pause',
  RESULTS_MADE_PUBLIC:           'results_made_public',
  RESULTS_MADE_PRIVATE:          'results_made_private',
  PUBLIC_CREATOR_REGISTERED:     'public_creator_registered',
} as const;
