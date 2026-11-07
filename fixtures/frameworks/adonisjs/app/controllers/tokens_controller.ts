import type { HttpContext } from '@adonisjs/core/http'

export default class TokensController {
  async index({ params }: HttpContext) {
    return { params }
  }

  async store({ params }: HttpContext) {
    return { params }
  }

  async show({ params }: HttpContext) {
    return { params }
  }

  async update({ params }: HttpContext) {
    return { params }
  }

  async destroy({ params }: HttpContext) {
    return { params }
  }
}
