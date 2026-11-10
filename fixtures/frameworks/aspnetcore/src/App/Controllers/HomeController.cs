using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

// No attribute routes: reached through the conventional route `{controller=Home}/{action=Index}/{id?}`.
public class HomeController : ControllerBase
{
    public IActionResult Index(int? id) => Ok($"Home {id}");

    public IActionResult Privacy() => Ok("Privacy");

    [HttpPost]
    public IActionResult Contact() => Ok("Sent");

    [NonAction]
    public string Helper() => "not an action";
}
