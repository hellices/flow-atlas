using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

[Route("Store")]
[Route("[controller]")]
public class ShopController : ControllerBase
{
    [HttpPost("Buy")]
    [HttpPost("Checkout")]
    public IActionResult Buy() => Ok("Bought");

    [Route("[action]/{id=1}")]
    public IActionResult Details(int id) => Ok($"Details {id}");
}
