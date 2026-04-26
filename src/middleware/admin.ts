import type { Request, Response, NextFunction } from 'express';

export function isAdmin(req: Request): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && req.session.userEmail === adminEmail;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdmin(req)) {
    res.status(403).render('error', {
      user: { email: req.session?.userEmail ?? '' },
      message: 'Acceso restringido.',
    });
    return;
  }
  next();
}
