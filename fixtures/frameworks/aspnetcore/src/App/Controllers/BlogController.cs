using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

public class BlogController : ControllerBase
{
    [HttpGet]
    public IActionResult Index() => Ok("Blog index");

    [HttpGet]
    public IActionResult Article(int id) => Ok($"Article {id}");
}
