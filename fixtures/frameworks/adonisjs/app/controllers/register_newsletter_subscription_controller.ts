import type { HttpContext } from '@adonisjs/core/http'

export default class RegisterNewsletterSubscriptionController {
  async handle({ request }: HttpContext) {
    return request.all()
  }
}
