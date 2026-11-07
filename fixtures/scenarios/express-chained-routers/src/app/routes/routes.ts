import { Router } from 'express';
import labelsController from './label/label.controller';
import notesController from './note/note.controller';

const api = Router()
  .use(labelsController)
  .use(notesController);

export default Router().use('/api', api);
