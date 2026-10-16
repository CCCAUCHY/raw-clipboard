UUID = raw-clipboard@local
ZIP = $(UUID).shell-extension.zip

.PHONY: all schemas mock-resource pack test clean

all: pack

schemas:
	glib-compile-schemas --strict schemas/

mock-resource:
	cd tests && glib-compile-resources mock.gresource.xml

test: schemas mock-resource
	GSETTINGS_BACKEND=memory gjs -m tests/smoke_test.js
	GSETTINGS_BACKEND=memory GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0:/usr/lib/mutter-51:/usr/lib/gnome-shell gjs -m tests/prefs_smoke_test.js
	GSETTINGS_BACKEND=memory LD_LIBRARY_PATH=/usr/lib/mutter-51:/usr/lib/gnome-shell GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0:/usr/lib/mutter-51:/usr/lib/gnome-shell gjs -m tests/boundary_stress_test.js
	GSETTINGS_BACKEND=memory LD_LIBRARY_PATH=/usr/lib/mutter-51:/usr/lib/gnome-shell GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0:/usr/lib/mutter-51:/usr/lib/gnome-shell gjs -m tests/full_functional_and_boundary_stress_test.js

pack: schemas
	gnome-extensions pack --extra-source=stylesheet.css --force

clean:
	rm -f schemas/gschemas.compiled tests/mock.gresource

