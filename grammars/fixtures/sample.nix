{
  description = "poly development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        rust = pkgs.rust-bin.stable.latest.default;

        # Tools poly refuses to download for you (toolchain-only).
        toolchainOnly = with pkgs; [ rustfmt clang-tools terraform ];
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = toolchainOnly ++ [ rust pkgs.nodejs_22 pkgs.python312 ];

          shellHook = ''
            export POLY_LOG=debug
            echo "poly dev shell on ${system}"
          '';
        };

        packages.default = pkgs.rustPlatform.buildRustPackage {
          pname = "poly";
          version = "0.2.0";
          src = ./cli;
          cargoLock.lockFile = ./cli/Cargo.lock;
          meta = with pkgs.lib; {
            description = "Unified formatter and linter";
            license = licenses.mit;
            platforms = platforms.unix;
          };
        };
      });
}
