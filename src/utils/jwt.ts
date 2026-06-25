import jwt from 'jsonwebtoken';
import { env } from '@/config/env';

export interface JwtAccessPayload {
  sub: string;   // userId
  email: string;
  iat?: number;
  exp?: number;
}

export interface JwtRefreshPayload {
  sub: string;   // userId
  jti: string;   // session id
  iat?: number;
  exp?: number;
}

export function signAccessToken(payload: Omit<JwtAccessPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: Omit<JwtRefreshPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtAccessPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtAccessPayload;
}

export function verifyRefreshToken(token: string): JwtRefreshPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtRefreshPayload;
}
