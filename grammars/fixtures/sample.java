package com.example.poly;

import java.util.List;
import java.util.stream.Collectors;

/** Records, sealed types, switch patterns and text blocks. */
public sealed interface Shape permits Circle, Square {

    record Circle(double radius) implements Shape {}

    record Square(double side) implements Shape {}

    static double area(Shape s) {
        return switch (s) {
            case Circle c -> Math.PI * c.radius() * c.radius();
            case Square q -> q.side() * q.side();
        };
    }

    static String report(List<Shape> shapes) {
        var total = shapes.stream().mapToDouble(Shape::area).sum();
        var names = shapes.stream()
                .map(s -> s.getClass().getSimpleName())
                .collect(Collectors.joining(", "));
        return """
                shapes: %s
                total : %.2f
                """.formatted(names, total);
    }
}
