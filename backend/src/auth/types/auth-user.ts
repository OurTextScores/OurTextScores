export interface AuthUserClaims {
  sub: string; // user id from identity provider (string)
  email?: string;
  name?: string;
  iat?: number;
  exp?: number;
  // passthrough for future fields
  [key: string]: unknown;
}

export interface RequestUser {
  userId: string;
  email?: string;
  name?: string;
  roles?: string[];
}

