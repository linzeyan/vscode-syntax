#!/usr/bin/env perl
use strict;
use warnings;
use feature qw(say);

my %count;
my $re = qr/^(?<level>\w+)\s+(?<msg>.+?)\s*$/;

while (my $line = <DATA>) {
    chomp $line;
    next unless $line =~ $re;
    $count{ $+{level} }++;
    say sprintf("%-5s %s", uc $+{level}, $+{msg});
}

for my $level (sort { $count{$b} <=> $count{$a} || $a cmp $b } keys %count) {
    printf "%s=%d\n", $level, $count{$level};
}

my @tags = map { "v0.$_.0" } grep { $_ % 2 == 0 } 1 .. 6;
say "tags: @tags";

__DATA__
info daemon started
warn tool not found
info cache hit
