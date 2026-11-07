import type { HttpContext } from '@adonisjs/core/http'

export default class TagsController {
  async index({}: HttpContext) {
    return []
  }

  async store({ request }: HttpContext) {
    return request.all()
  }

  async destroy({ params }: HttpContext) {
    return { id: params.id }
  }
}
