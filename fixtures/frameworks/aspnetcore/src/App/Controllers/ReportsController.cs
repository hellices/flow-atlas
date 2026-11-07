using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

[Area("Admin")]
[Route("[area]/[controller]/[action]")]
public class ReportsController : ControllerBase
{
    [HttpGet]
    public IActionResult Daily() => Ok("Daily");

    [HttpGet("{year:int}")]
    public IActionResult Yearly(int year) => Ok($"Yearly {year}");

    [HttpPost]
    public IActionResult Rebuild() => Ok("Rebuilt");
}
