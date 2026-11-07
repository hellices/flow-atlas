using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok("All products");

    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok($"Product {id}");

    [HttpPost]
    public IActionResult Create() => Ok("Created");

    [HttpPut("{id:int}")]
    public IActionResult Update(int id) => Ok($"Updated {id}");

    [HttpDelete("{id:int}")]
    public IActionResult Delete(int id) => Ok($"Deleted {id}");

    [HttpGet("[action]/{term?}")]
    public IActionResult Search(string? term) => Ok($"Search {term}");

    [HttpGet("~/catalog/featured")]
    public IActionResult Featured() => Ok("Featured");

    [HttpGet("/top")]
    public IActionResult Top() => Ok("Top");

    [AcceptVerbs("GET", "POST", Route = "{id:int}/reviews")]
    public IActionResult Reviews(int id) => Ok($"Reviews of {id}");
}
