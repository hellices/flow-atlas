using FluentValidation;

namespace App.Modules;

public record Person(string Name);

public class PersonValidator : AbstractValidator<Person>
{
    public PersonValidator()
    {
        RuleFor(x => x.Name).NotEmpty();
    }
}
