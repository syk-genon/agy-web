# Firebase Studio (Project IDX) Environment Configuration
{ pkgs, ... }: {
  # Channel to use for packages
  channel = "stable-24.05";

  # System packages available in the workspace
  packages = [
    pkgs.nodejs_20
    pkgs.curl
    pkgs.git
  ];

  env = {
    PORT = "$PORT";
  };

  idx = {
    extensions = [];

    # Workspace lifecycle hooks
    workspace = {
      onCreate = {
        # Ensure agy is available in path or can be installed via CLI setup
      };
      onStart = {};
    };

    # Automatically launch and preview the Web UI in Firebase Studio
    previews = {
      enable = true;
      previews = {
        web = {
          command = ["node" "server.js"];
          manager = "web";
          env = {
            PORT = "$PORT";
          };
        };
      };
    };
  };
}
