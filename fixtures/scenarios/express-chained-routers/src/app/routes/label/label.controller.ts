import { NextFunction, Request, Response, Router } from 'express';
import { popularLabels } from './label.service';

const router = Router();

/**
 * Get the most used labels
 * @route {GET} /api/labels
 */
router.get('/labels', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ labels: await popularLabels() });
  } catch (error) {
    next(error);
  }
});

export default router;
