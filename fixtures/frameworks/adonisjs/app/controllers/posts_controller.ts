import type { HttpContext } from '@adonisjs/core/http'

export default class PostsController {
  async index({}: HttpContext) {
    return []
  }

  async create({}: HttpContext) {
    return 'form'
  }

  async store({ request }: HttpContext) {
    return request.all()
  }

  async show({ params }: HttpContext) {
    return { id: params.id }
  }

  async edit({ params }: HttpContext) {
    return { id: params.id }
  }

  async update({ params }: HttpContext) {
    return { id: params.id }
  }

  async destroy({ params }: HttpContext) {
    return { id: params.id }
  }
}
