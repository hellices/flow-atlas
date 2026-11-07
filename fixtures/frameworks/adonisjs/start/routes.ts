/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes of AdonisJS's routing and controllers guides (docs.adonisjs.com/guides/basics/routing, /controllers):
| static and dynamic routes, several params, an optional and a wildcard param, matchers (built-in and custom), every
| method, `any` and `route` with custom verbs, redirects, groups with prefixes (nested, without a leading `/`), resources
| (nested, shallow, `apiOnly`, `only`, `except`, renamed params, inside a group) and a single action controller.
|
*/

import router from '@adonisjs/core/services/router'

const PostsController = () => import('#controllers/posts_controller')
const CommentsController = () => import('#controllers/comments_controller')
const PhotosController = () => import('#controllers/photos_controller')
const UsersController = () => import('#controllers/users_controller')
const TagsController = () => import('#controllers/tags_controller')
const TokensController = () => import('#controllers/tokens_controller')
const RegisterNewsletterSubscriptionController = () =>
  import('#controllers/register_newsletter_subscription_controller')

router.get('/', () => 'Hello world from the home page.')
router.get('/about', () => 'This is the about page.')

// Static routes before the dynamic ones they overlap.
router.get('/posts/archived', () => 'Showing archived posts')
router.get('/posts/trending', () => 'Showing trending posts')
router.resource('posts', PostsController)
router.resource('posts.comments', CommentsController).apiOnly()
router.shallowResource('posts.photos', PhotosController).only(['index', 'store', 'show', 'destroy'])
router.resource('users', UsersController).except(['create', 'edit']).params({ users: 'user' })
router.resource('tags', TagsController).only(['index', 'store', 'destroy'])

router.get('/posts/:id/comments/:commentId/likes', ({ params }) => `${params.id} ${params.commentId}`)
router.get('/drafts/:id?', ({ params }) => (params.id ? `draft ${params.id}` : 'all drafts'))
router.get('/docs/:category/*', ({ params }) => `${params.category} ${params['*'].join('/')}`)
router.get('/files/*', ({ params }) => params['*'].join('/'))

router
  .get('/articles/:slug', ({ params }) => params.slug)
  .where('slug', router.matchers.slug())
router
  .get('/accounts/:accountId', ({ params }) => params.accountId)
  .where('accountId', router.matchers.uuid())
router
  .get('/invoices/:id', ({ params }) => params.id)
  .where('id', router.matchers.number())
router
  .get('/invoices/:id/lines/:line', ({ params }) => `${params.id} ${params.line}`)
  .where('id', router.matchers.number())
  .where('line', { match: /^[0-9]+$/, cast: (value) => Number(value) })

router.any('/webhooks', () => 'received')
router.route('/api/data', ['GET', 'POST', 'PUT'], () => 'data')
router.route('/', ['TRACE'], () => 'traced')

router.on('/old-blog').redirectToPath('/blog', { status: 301 })
router.on('/featured').redirect('posts.show', { id: 1 })

router.post('/newsletter/subscriptions', [RegisterNewsletterSubscriptionController])

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', () => 'signed up').as('signup')
        router.post('login', () => 'logged in').as('login')
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', () => 'profile').as('profile')
        router.resource('tokens', TokensController).apiOnly()
      })
      .prefix('account')
      .as('account')
  })
  .prefix('/api/v1')
