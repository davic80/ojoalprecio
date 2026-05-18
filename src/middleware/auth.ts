import type { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    console.log(`[requireAuth] NO SESSION → /auth/login (path=${req.method} ${req.path}, sid=${(req as any).sessionID?.slice(0,8)})`);
    res.redirect('/auth/login');
    return;
  }
  if (!req.session.emailVerified) {
    console.log(`[requireAuth] UNVERIFIED EMAIL → /auth/verify-pending (user=${req.session.userId}, path=${req.method} ${req.path})`);
    res.redirect('/auth/verify-pending');
    return;
  }
  next();
}
