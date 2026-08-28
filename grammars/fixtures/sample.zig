const std = @import("std");

const User = struct {
    id: u32,
    name: []const u8,
};

pub fn main() !void {
    const u = User{ .id = 1, .name = "poly" };
    std.debug.print("Hello, {s} ({d})\n", .{ u.name, u.id });
}
