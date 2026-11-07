import express from 'express';
import routes from './app/routes/routes';

const app = express();

app.use(express.json());
app.use(routes);

// Serves images
app.use(express.static(__dirname + '/assets'));

app.get('/', (req: express.Request, res: express.Response) => {
  res.json({ status: 'API is running on /api' });
});

app.listen(process.env.PORT || 3000);
