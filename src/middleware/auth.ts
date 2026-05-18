import type { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.redirect('/auth/login');
    return;
  }
  if (!req.session.emailVerified) {
    res.redirect('/auth/verify-pending');
    return;
  }
  next();
}
