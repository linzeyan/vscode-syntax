using System.Collections.Generic;

namespace Poly;

public record User(int Id, string Name);

public static class Greeter
{
    public static string Greet(User user) =>
        user.Id > 0 ? $"Hello, {user.Name}!" : "unknown";
}
