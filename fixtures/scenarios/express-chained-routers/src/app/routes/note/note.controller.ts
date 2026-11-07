import { NextFunction, Request, Response, Router } from 'express';
import { createNote, deleteNote, getNote, listNotes } from './note.service';

const router = Router();

router.get('/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listNotes(req.query));
  } catch (error) {
    next(error);
  }
});

router.post('/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await createNote(req.body.note));
  } catch (error) {
    next(error);
  }
});

router.get('/notes/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getNote(req.params.slug));
  } catch (error) {
    next(error);
  }
});

router.delete('/notes/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteNote(req.params.slug);
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

export default router;
